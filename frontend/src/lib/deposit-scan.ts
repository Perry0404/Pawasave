/**
 * deposit-scan.ts — scans Base for incoming cNGN transfers to user deposit
 * addresses and credits them (idempotently) to the user's balance, so a crypto
 * deposit shows up just like a fiat deposit. SERVER ONLY.
 *
 * Two entry points share this logic:
 *   - /api/cron/scan-deposits   → full scan across all users (advances cursor)
 *   - /api/wallet/sync-deposits → quick recent scan for one signed-in user
 *
 * Required env vars:
 *   BASE_MAINNET_RPC_URL (or NEXT_PUBLIC_BASE_RPC_URL)
 *   SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL
 *   DEPOSIT_WALLET_MNEMONIC
 */
import { ethers } from "ethers"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { sendPushToUser } from "./push-send"
import { CONTRACTS } from "./contracts"
import { deriveDepositAddress, depositWalletConfigured } from "./deposit-wallet"
import { getBaseProvider, alchemyRpcUrl } from "./rpc-provider"

const TRANSFER_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"]

// getLogs path (paid/uncapped RPCs only): max blocks per full run + address chunk.
// Alchemy's FREE tier caps eth_getLogs at ~10 blocks, which is why the old
// getLogs scanner silently 400'd every run and the cursor stalled for days. When
// an Alchemy endpoint is configured we use alchemy_getAssetTransfers instead — it
// has NO range cap, so one run can catch up an arbitrarily large backlog.
const MAX_SPAN    = 3000
const RECENT_SPAN = 7200   // self-sync look-back (~4h on Base)
const ADDR_CHUNK  = 150
const ALCHEMY_MAX_SPAN = 2_000_000 // effectively "scan to head" for the transfers API
const toHex = (n: number) => '0x' + Math.max(0, n).toString(16)

export interface CreditedDeposit {
  userId: string
  address: string
  txHash: string
  amountCngnMicro: string
}

function admin(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

interface WalletRow { user_id: string; deposit_index: number | null; deposit_address: string | null }

/** Build address→user map, deriving + persisting any missing addresses. */
async function buildAddressMap(
  supabase: SupabaseClient,
  onlyUserId?: string,
): Promise<Map<string, { userId: string; address: string }>> {
  let query = supabase.from("wallets").select("user_id, deposit_index, deposit_address")
  if (onlyUserId) query = query.eq("user_id", onlyUserId)
  const { data, error } = await query
  if (error) throw new Error(`load wallets: ${error.message}`)

  const map = new Map<string, { userId: string; address: string }>()
  for (const w of (data ?? []) as WalletRow[]) {
    if (w.deposit_index == null) continue
    let addr = w.deposit_address
    if (!addr) {
      addr = await deriveDepositAddress(Number(w.deposit_index))
      await supabase.rpc("set_deposit_address", { p_user_id: w.user_id, p_address: addr })
    }
    map.set(addr.toLowerCase(), { userId: w.user_id, address: addr })
  }
  return map
}

type Owner = { userId: string; address: string }

/** Idempotently credit one inbound transfer; fire the deposit push on first credit. */
async function creditOne(
  supabase: SupabaseClient, owner: Owner, hash: string, logIndex: number, block: number, micro: bigint,
): Promise<CreditedDeposit | null> {
  const { data: ok } = await supabase.rpc("credit_crypto_deposit", {
    p_user_id: owner.userId, p_amount_cngn_micro: micro.toString(),
    p_tx_hash: hash, p_log_index: logIndex, p_address: owner.address, p_block: block,
  })
  if (!ok) return null
  const ngn = (Number(micro) / 1_000_000).toLocaleString('en-NG', { maximumFractionDigits: 2 })
  sendPushToUser(owner.userId, { title: 'Deposit received', body: `₦${ngn} has landed in your PawaSave balance.`, url: '/', tag: 'deposit' }).catch(() => {})
  return { userId: owner.userId, address: owner.address, txHash: hash, amountCngnMicro: micro.toString() }
}

/** Inbound cNGN to one address via alchemy_getAssetTransfers (no getLogs range cap). */
async function alchemyInbound(addr: string, fromBlock: number, toBlock: number) {
  const url = alchemyRpcUrl()
  if (!url) return null // caller falls back to getLogs
  const out: Array<{ to: string; hash: string; block: number; logIndex: number; micro: bigint }> = []
  let pageKey: string | undefined
  for (let pages = 0; pages < 25; pages++) {
    const params: Record<string, unknown> = {
      fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), toAddress: addr,
      contractAddresses: [CONTRACTS.CNGN], category: ['erc20'], excludeZeroValue: true,
      maxCount: '0x3e8', order: 'asc',
    }
    if (pageKey) params.pageKey = pageKey
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`getAssetTransfers HTTP ${res.status}`)
    const j = await res.json()
    if (j.error) throw new Error(`getAssetTransfers: ${JSON.stringify(j.error)}`)
    for (const t of (j.result?.transfers ?? [])) {
      const raw = t.rawContract?.value ? BigInt(t.rawContract.value) : 0n
      if (raw <= 0n || !t.to) continue
      const m = String(t.uniqueId || '').match(/:log:(\d+)/i)
      out.push({ to: String(t.to).toLowerCase(), hash: t.hash, block: t.blockNum ? parseInt(t.blockNum, 16) : 0, logIndex: m ? Number(m[1]) : 0, micro: raw })
    }
    pageKey = j.result?.pageKey
    if (!pageKey) break
  }
  return out
}

async function creditEvents(
  supabase: SupabaseClient,
  cngn: ethers.Contract,
  addresses: string[],
  fromBlock: number,
  toBlock: number,
  map: Map<string, Owner>,
): Promise<CreditedDeposit[]> {
  const credited: CreditedDeposit[] = []

  // Preferred path: Alchemy transfers API — no block-range cap, so it works on the
  // free tier and can catch up an arbitrarily large backlog in one run.
  if (alchemyRpcUrl()) {
    for (const addr of addresses) {
      const transfers = await alchemyInbound(addr, fromBlock, toBlock)
      for (const t of transfers ?? []) {
        const owner = map.get(t.to)
        if (!owner) continue
        const c = await creditOne(supabase, owner, t.hash, t.logIndex, t.block, t.micro)
        if (c) credited.push(c)
      }
    }
    return credited
  }

  // Fallback: chunked getLogs (only reliable on a paid/uncapped RPC).
  for (let i = 0; i < addresses.length; i += ADDR_CHUNK) {
    const chunk = addresses.slice(i, i + ADDR_CHUNK)
    const filter = cngn.filters.Transfer(null, chunk)
    const logs = await cngn.queryFilter(filter, fromBlock, toBlock)
    for (const log of logs) {
      const ev = log as ethers.EventLog
      const to    = String(ev.args?.to ?? ev.args?.[1] ?? "").toLowerCase()
      const value = BigInt(ev.args?.value ?? ev.args?.[2] ?? 0)
      const owner = map.get(to)
      if (!owner || value <= 0n) continue
      const c = await creditOne(supabase, owner, ev.transactionHash, ev.index, ev.blockNumber, value)
      if (c) credited.push(c)
    }
  }
  return credited
}

/**
 * Scan + credit. Full mode (no onlyUserId) advances the global cursor; self
 * mode scans a recent window for one user only.
 */
export async function scanAndCredit(opts: { onlyUserId?: string } = {}): Promise<{
  credited: CreditedDeposit[]; fromBlock: number; toBlock: number; scannedAddresses: number
}> {
  if (!depositWalletConfigured()) throw new Error("DEPOSIT_WALLET_MNEMONIC not configured")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured")

  const supabase = admin()
  const provider = getBaseProvider()
  const cngn     = new ethers.Contract(CONTRACTS.CNGN, TRANSFER_ABI, provider)

  const map = await buildAddressMap(supabase, opts.onlyUserId)
  const addresses = [...map.values()].map(v => v.address)
  if (addresses.length === 0) return { credited: [], fromBlock: 0, toBlock: 0, scannedAddresses: 0 }

  const currentBlock = await provider.getBlockNumber()
  const alchemy = !!alchemyRpcUrl()
  const span = alchemy ? ALCHEMY_MAX_SPAN : MAX_SPAN
  let fromBlock: number
  let toBlock: number

  if (opts.onlyUserId) {
    // Recent window for a single user; do not move the global cursor. With Alchemy
    // (no range cap) look back far enough to catch deposits missed while the scanner
    // was stalled; credit_crypto_deposit is idempotent so re-scanning is safe.
    const lookback = alchemy ? 600_000 : RECENT_SPAN
    fromBlock = Math.max(0, currentBlock - lookback)
    toBlock   = currentBlock
  } else {
    const { data: state } = await supabase
      .from("deposit_scan_state").select("last_block").eq("id", 1).single()
    const last = Number(state?.last_block ?? 0)
    fromBlock = last > 0 ? last + 1 : Math.max(0, currentBlock - span)
    toBlock   = Math.min(currentBlock, fromBlock + span)
    if (fromBlock > toBlock) return { credited: [], fromBlock, toBlock, scannedAddresses: addresses.length }
  }

  const credited = await creditEvents(supabase, cngn, addresses, fromBlock, toBlock, map)

  if (!opts.onlyUserId) {
    await supabase.from("deposit_scan_state")
      .update({ last_block: toBlock, updated_at: new Date().toISOString() })
      .eq("id", 1)
  }

  return { credited, fromBlock, toBlock, scannedAddresses: addresses.length }
}
