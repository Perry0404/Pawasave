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
import { CONTRACTS } from "./contracts"
import { deriveDepositAddress, depositWalletConfigured } from "./deposit-wallet"

const RPC =
  process.env.BASE_MAINNET_RPC_URL ||
  process.env.NEXT_PUBLIC_BASE_RPC_URL ||
  "https://mainnet.base.org"

const TRANSFER_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"]

const MAX_SPAN    = 3000   // max blocks per full cron run (RPC getLogs safety)
const RECENT_SPAN = 7200   // self-sync look-back (~4h on Base)
const ADDR_CHUNK  = 150    // addresses per getLogs filter

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

async function creditEvents(
  supabase: SupabaseClient,
  cngn: ethers.Contract,
  addresses: string[],
  fromBlock: number,
  toBlock: number,
  map: Map<string, { userId: string; address: string }>,
): Promise<CreditedDeposit[]> {
  const credited: CreditedDeposit[] = []
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
      const { data: ok } = await supabase.rpc("credit_crypto_deposit", {
        p_user_id: owner.userId,
        p_amount_cngn_micro: value.toString(),
        p_tx_hash: ev.transactionHash,
        p_log_index: ev.index,
        p_address: owner.address,
        p_block: ev.blockNumber,
      })
      if (ok) {
        credited.push({
          userId: owner.userId, address: owner.address,
          txHash: ev.transactionHash, amountCngnMicro: value.toString(),
        })
      }
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
  const provider = new ethers.JsonRpcProvider(RPC)
  const cngn     = new ethers.Contract(CONTRACTS.CNGN, TRANSFER_ABI, provider)

  const map = await buildAddressMap(supabase, opts.onlyUserId)
  const addresses = [...map.values()].map(v => v.address)
  if (addresses.length === 0) return { credited: [], fromBlock: 0, toBlock: 0, scannedAddresses: 0 }

  const currentBlock = await provider.getBlockNumber()
  let fromBlock: number
  let toBlock: number

  if (opts.onlyUserId) {
    // Recent window for a single user; do not move the global cursor.
    fromBlock = Math.max(0, currentBlock - RECENT_SPAN)
    toBlock   = currentBlock
  } else {
    const { data: state } = await supabase
      .from("deposit_scan_state").select("last_block").eq("id", 1).single()
    const last = Number(state?.last_block ?? 0)
    fromBlock = last > 0 ? last + 1 : Math.max(0, currentBlock - MAX_SPAN)
    toBlock   = Math.min(currentBlock, fromBlock + MAX_SPAN)
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
