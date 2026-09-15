/**
 * crosschain-deposit.ts — orchestrates the USDC/USDT-on-any-chain → cNGN-on-Base deposit.
 * SERVER ONLY. Driven by /api/cron/scan-crosschain-deposits.
 *
 * Per enabled source chain (lib/deposit-chains.ts):
 *   1. SCAN  — find inbound USDC/USDT to the users' HD deposit addresses since the chain cursor
 *              (Alchemy getAssetTransfers; falls back to getLogs on a non-Alchemy RPC).
 *   2. RECORD — idempotently insert a crosschain_deposits row per (chain, tx, logIndex).
 *   3. SETTLE — for each not-yet-credited row: gas-fund the deposit address, sweep the token to
 *              custody on the source chain, place a HyperFX cross-chain intent (source token →
 *              cNGN on Base), then credit the user net of the deposit fee.
 *
 * Every on-chain step is best-effort and idempotent at the DB layer, so a crash/retry never
 * double-credits and a stuck intent's escrow is reclaimable (ops/cancel-stuck-orders.mjs).
 *
 * Operational prerequisites per chain: a read RPC (<CHAIN>_RPC_URL), custody native gas + a
 * small USDC fee buffer on that chain, and a bundler (<CHAIN>_BUNDLER_URL). Dark until
 * CROSSCHAIN_DEPOSIT_ENABLED=true and the chain is listed in CROSSCHAIN_DEPOSIT_CHAINS.
 */
import { ethers } from 'ethers'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  enabledChains, rpcUrlFor, bundlerUrlFor, resolveChainAssets,
  type SourceChain, type ChainAsset,
} from './deposit-chains'
import { deriveDepositSigner, depositWalletConfigured } from './deposit-wallet'
import { custodyAddress } from './custody'
import { getSecret } from './secrets'
import { depositCrossChainToCngn } from './hyperfx'
import { depositFeeNgn } from './deposit-fee'

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]
const SCAN_MAX_SPAN = 2_000_000       // Alchemy transfers API has no range cap
const MAX_SETTLE_PER_RUN = 5          // bound on-chain work per cron tick

function admin(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
    // no-store: this runs in a cron route that reads tables via GET; Next's App Router caches
    // GET fetches, which would serve a stale scan cursor / pending list forever (see the
    // equity-sell-reconcile cache fix).
    global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, cache: 'no-store' }) },
  })
}
const toHex = (n: number) => '0x' + Math.max(0, n).toString(16)
const isAlchemy = (url: string) => /alchemy\.com/i.test(url)

interface WalletRow { user_id: string; deposit_index: number | null; deposit_address: string | null }

/** address(lowercase) → { userId, address } across all users with a deposit address. */
async function addressMap(db: SupabaseClient): Promise<Map<string, { userId: string; address: string }>> {
  const { data, error } = await db.from('wallets').select('user_id, deposit_index, deposit_address')
  if (error) throw new Error(`load wallets: ${error.message}`)
  const map = new Map<string, { userId: string; address: string }>()
  for (const w of (data ?? []) as WalletRow[]) {
    if (w.deposit_index == null || !w.deposit_address) continue
    map.set(w.deposit_address.toLowerCase(), { userId: w.user_id, address: w.deposit_address })
  }
  return map
}

interface Detection { to: string; token: string; hash: string; block: number; logIndex: number; raw: bigint }

/** Inbound USDC/USDT to `addresses` on one chain, via Alchemy getAssetTransfers (no range cap). */
async function scanInbound(rpc: string, tokens: string[], addresses: string[], fromBlock: number, toBlock: number): Promise<Detection[]> {
  const out: Detection[] = []
  if (isAlchemy(rpc)) {
    for (const addr of addresses) {
      let pageKey: string | undefined
      for (let pages = 0; pages < 25; pages++) {
        const params: Record<string, unknown> = {
          fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), toAddress: addr,
          contractAddresses: tokens, category: ['erc20'], excludeZeroValue: true, maxCount: '0x3e8', order: 'asc',
        }
        if (pageKey) params.pageKey = pageKey
        const res = await fetch(rpc, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }),
          signal: AbortSignal.timeout(20_000),
        })
        if (!res.ok) throw new Error(`getAssetTransfers HTTP ${res.status}`)
        const j = await res.json()
        if (j.error) throw new Error(`getAssetTransfers: ${JSON.stringify(j.error)}`)
        for (const t of (j.result?.transfers ?? [])) {
          const raw = t.rawContract?.value ? BigInt(t.rawContract.value) : 0n
          if (raw <= 0n || !t.to || !t.rawContract?.address) continue
          const m = String(t.uniqueId || '').match(/:log:(\d+)/i)
          out.push({ to: String(t.to).toLowerCase(), token: String(t.rawContract.address).toLowerCase(), hash: t.hash, block: t.blockNum ? parseInt(t.blockNum, 16) : 0, logIndex: m ? Number(m[1]) : 0, raw })
        }
        pageKey = j.result?.pageKey
        if (!pageKey) break
      }
    }
    return out
  }
  // Fallback: chunked getLogs Transfer(*, address) per token (paid/uncapped RPC only).
  const provider = new ethers.JsonRpcProvider(rpc)
  for (const token of tokens) {
    const c = new ethers.Contract(token, ['event Transfer(address indexed from, address indexed to, uint256 value)'], provider)
    const logs = await c.queryFilter(c.filters.Transfer(null, addresses), fromBlock, toBlock).catch(() => [])
    for (const l of logs as ethers.EventLog[]) {
      const to = String(l.args?.to ?? '').toLowerCase(); const raw = BigInt(l.args?.value ?? 0)
      if (!to || raw <= 0n) continue
      out.push({ to, token: token.toLowerCase(), hash: l.transactionHash, block: l.blockNumber, logIndex: l.index, raw })
    }
  }
  return out
}

/** Sweep a deposit address's full token balance → custody on the source chain (gas-funded). */
async function sweepToCustody(chain: SourceChain, depositIndex: number, tokenAddr: string, provider: ethers.JsonRpcProvider): Promise<{ amount: bigint; txHash: string }> {
  const funderKey = (await getSecret('DEPOSIT_GAS_FUNDER_PRIVATE_KEY')) || (await getSecret('CUSTODY_PRIVATE_KEY'))
  if (!funderKey || funderKey === '0x') throw new Error('No gas funder key')
  const custody = await custodyAddress()
  const funder = new ethers.Wallet(funderKey, provider)
  const signer = await deriveDepositSigner(depositIndex, provider)
  const tokenRead = new ethers.Contract(tokenAddr, ERC20_ABI, provider)
  const bal = BigInt(await tokenRead.balanceOf(await signer.getAddress()))
  if (bal <= 0n) throw new Error('nothing to sweep (already swept?)')

  const GAS_LIMIT = 120_000n
  const fee = await provider.getFeeData()
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000n
  const needed = (GAS_LIMIT * gasPrice * 13n) / 10n
  const have = await provider.getBalance(await signer.getAddress())
  if (have < needed) {
    await (await funder.sendTransaction({ to: await signer.getAddress(), value: needed - have })).wait()
  }
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer)
  const tx = await token.transfer(custody, bal, { gasLimit: GAS_LIMIT })
  await tx.wait()
  return { amount: bal, txHash: tx.hash }
}

type Row = {
  id: number; user_id: string; chain_key: string; token_symbol: string
  deposit_address: string; raw_amount: string; token_decimals: number; status: string
}

/** Settle one detected deposit end-to-end: sweep → cross-chain intent → credit. */
async function settleOne(db: SupabaseClient, chain: SourceChain, assets: ChainAsset[], row: Row): Promise<void> {
  const asset = assets.find((a) => a.symbol === row.token_symbol)
  if (!asset) throw new Error(`asset ${row.token_symbol} not on ${chain.key}`)
  const provider = new ethers.JsonRpcProvider(rpcUrlFor(chain))

  // 1. sweep deposit → custody on the source chain. On a RETRY of a row already past sweep
  // ('settling'), the funds are in custody already, so skip the sweep and reuse raw_amount —
  // re-sweeping would grab another user's funds or throw (deposit address is empty).
  let amountIn: bigint
  if (row.status === 'settling') {
    amountIn = BigInt(row.raw_amount)
  } else {
    await db.rpc('mark_crosschain_deposit', { p_id: row.id, p_status: 'sweeping' })
    const idx = await depositIndexFor(db, row.user_id)
    const swept = await sweepToCustody(chain, idx, asset.address, provider)
    amountIn = swept.amount
    await db.rpc('mark_crosschain_deposit', { p_id: row.id, p_status: 'settling', p_swept_tx: swept.txHash })
  }

  // 2. custody places the cross-chain intent: source token → cNGN on Base
  const cngnGross = await depositCrossChainToCngn({
    source: { key: chain.key, chainId: chain.chainId, stateMachineId: chain.stateMachineId, rpc: rpcUrlFor(chain), bundler: bundlerUrlFor(chain) },
    tokenInAddr: asset.address,
    amountIn,
    beneficiaryBase: await custodyAddress(),
  })

  // 3. credit the user, net of the deposit fee (free under ₦50k, flat ₦30 above)
  const grossNgn = Number(cngnGross) / 1e6
  const feeMicro = BigInt(Math.round(depositFeeNgn(grossNgn) * 1e6))
  await db.rpc('credit_crosschain_deposit', {
    p_id: row.id, p_cngn_gross_micro: cngnGross.toString(), p_fee_micro: feeMicro.toString(),
    p_base_fill_ref: `ccdep:${chain.key}:${row.id}`,
  })
}

async function depositIndexFor(db: SupabaseClient, userId: string): Promise<number> {
  const { data } = await db.from('wallets').select('deposit_index').eq('user_id', userId).single()
  const idx = Number(data?.deposit_index)
  if (!Number.isInteger(idx) || idx < 0) throw new Error('no deposit_index for user')
  return idx
}

export async function runCrossChainDeposits(): Promise<Record<string, unknown>> {
  if (!(await depositWalletConfigured())) throw new Error('DEPOSIT_WALLET_MNEMONIC not configured')
  const db = admin()
  const chains = enabledChains()
  if (chains.length === 0) return { enabled: false, note: 'CROSSCHAIN_DEPOSIT_ENABLED off or no chains configured' }

  const map = await addressMap(db)
  const addresses = [...map.values()].map((v) => v.address)
  const summary: Record<string, unknown> = { chains: {} }

  for (const chain of chains) {
    const chainOut: Record<string, unknown> = {}
    try {
      const rpc = rpcUrlFor(chain)
      const assets = await resolveChainAssets(chain)
      const tokens = assets.map((a) => a.address.toLowerCase())
      const provider = new ethers.JsonRpcProvider(rpc)
      const head = await provider.getBlockNumber()

      // scan since cursor
      const { data: st } = await db.from('crosschain_scan_state').select('last_block').eq('chain_key', chain.key).maybeSingle()
      const last = Number(st?.last_block ?? 0)
      const fromBlock = last > 0 ? last + 1 : Math.max(0, head - SCAN_MAX_SPAN)
      const toBlock = head
      let detected = 0
      if (addresses.length && toBlock >= fromBlock) {
        const dets = await scanInbound(rpc, tokens, addresses, fromBlock, toBlock)
        for (const d of dets) {
          const owner = map.get(d.to)
          if (!owner) continue
          const asset = assets.find((a) => a.address.toLowerCase() === d.token)
          if (!asset) continue
          await db.rpc('record_crosschain_deposit', {
            p_user_id: owner.userId, p_chain_key: chain.key, p_token_symbol: asset.symbol,
            p_src_tx_hash: d.hash, p_src_log_index: d.logIndex, p_deposit_addr: owner.address,
            p_raw_amount: d.raw.toString(), p_token_decimals: asset.decimals,
          })
          detected++
        }
      }
      await db.from('crosschain_scan_state').upsert({ chain_key: chain.key, last_block: toBlock, updated_at: new Date().toISOString() }, { onConflict: 'chain_key' })

      // settle pending rows for this chain (bounded)
      const { data: pending } = await db.from('crosschain_deposits')
        .select('id,user_id,chain_key,token_symbol,deposit_address,raw_amount,token_decimals,status')
        .eq('chain_key', chain.key).in('status', ['detected', 'sweeping', 'settling'])
        .order('created_at', { ascending: true }).limit(MAX_SETTLE_PER_RUN)
      let settled = 0, failed = 0
      for (const row of (pending ?? []) as Row[]) {
        try { await settleOne(db, chain, assets, row); settled++ }
        catch (e) {
          failed++
          await db.rpc('mark_crosschain_deposit', { p_id: row.id, p_status: 'failed', p_error: (e instanceof Error ? e.message : String(e)).slice(0, 400) })
        }
      }
      chainOut.detected = detected; chainOut.settled = settled; chainOut.failed = failed; chainOut.toBlock = toBlock
    } catch (e) {
      chainOut.error = e instanceof Error ? e.message : String(e)
    }
    ;(summary.chains as Record<string, unknown>)[chain.key] = chainOut
  }
  return summary
}
