/**
 * deposit-sweep.ts — sweeps cNGN out of the per-user derived deposit addresses
 * into a single custody address, so the HD deposit wallets never accumulate user
 * funds. SERVER ONLY.
 *
 * Why (CRIT-03): every user's deposit address derives from one mnemonic
 * (DEPOSIT_WALLET_MNEMONIC). Today deposits sit in those addresses indefinitely,
 * so a mnemonic leak drains everyone at once. Continually sweeping balances to
 * one custody address means a leak yields ~nothing — the hot addresses are empty.
 *
 * Per address holding cNGN >= DEPOSIT_SWEEP_MIN_CNGN:
 *   1. if it lacks ETH for one ERC-20 transfer, top it up from the gas funder
 *   2. transfer its full cNGN balance → DEPOSIT_SWEEP_DESTINATION
 *
 * Required env:
 *   DEPOSIT_SWEEP_DESTINATION       — address to receive funds. Use a COLD address
 *                                     (hardware wallet / Safe) for best security.
 *   DEPOSIT_WALLET_MNEMONIC, BASE_MAINNET_RPC_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   NEXT_PUBLIC_SUPABASE_URL
 * Optional env:
 *   DEPOSIT_GAS_FUNDER_PRIVATE_KEY  — hot key paying gas top-ups (defaults to
 *                                     CUSTODY_PRIVATE_KEY)
 *   DEPOSIT_SWEEP_MIN_CNGN          — micro-cNGN floor to bother sweeping (default 100 cNGN)
 *   DEPOSIT_SWEEP_MAX               — max addresses swept per run (default 10)
 */
import { ethers } from "ethers"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { CONTRACTS } from "./contracts"
import { deriveDepositSigner, depositWalletConfigured } from "./deposit-wallet"

const RPC =
  process.env.BASE_MAINNET_RPC_URL ||
  process.env.NEXT_PUBLIC_BASE_RPC_URL ||
  "https://mainnet.base.org"

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]

const DEFAULT_MIN_SWEEP = 100n * 1_000_000n // 100 cNGN (6 decimals)

function admin(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

interface WalletRow { user_id: string; deposit_index: number | null; deposit_address: string | null }

export interface SweptDeposit {
  userId: string
  address: string
  amountCngnMicro: string
  txHash: string
}

export async function sweepDeposits(): Promise<{
  swept: SweptDeposit[]
  skipped: Record<string, unknown>[]
  scanned: number
}> {
  if (!depositWalletConfigured()) throw new Error("DEPOSIT_WALLET_MNEMONIC not configured")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured")

  const destination = process.env.DEPOSIT_SWEEP_DESTINATION
  if (!destination || !ethers.isAddress(destination)) {
    throw new Error("DEPOSIT_SWEEP_DESTINATION not set or invalid")
  }
  const funderKey = process.env.DEPOSIT_GAS_FUNDER_PRIVATE_KEY || process.env.CUSTODY_PRIVATE_KEY
  if (!funderKey || funderKey === "0x") {
    throw new Error("No gas funder key (DEPOSIT_GAS_FUNDER_PRIVATE_KEY or CUSTODY_PRIVATE_KEY)")
  }

  const minSweep  = BigInt(process.env.DEPOSIT_SWEEP_MIN_CNGN || DEFAULT_MIN_SWEEP.toString())
  const maxSweeps = Number(process.env.DEPOSIT_SWEEP_MAX || 10)

  const supabase = admin()
  const provider = new ethers.JsonRpcProvider(RPC)
  const funder   = new ethers.Wallet(funderKey, provider)
  const cngnRead = new ethers.Contract(CONTRACTS.CNGN, ERC20_ABI, provider)

  const { data, error } = await supabase
    .from("wallets")
    .select("user_id, deposit_index, deposit_address")
  if (error) throw new Error(`load wallets: ${error.message}`)

  const swept: SweptDeposit[] = []
  const skipped: Record<string, unknown>[] = []
  let scanned = 0

  // Bail early if the gas funder is dry — surfaces an actionable signal instead
  // of N identical per-address failures.
  const funderEth = await provider.getBalance(funder.address)
  if (funderEth === 0n) {
    return { swept, skipped: [{ error: "gas funder has no ETH", funder: funder.address }], scanned: 0 }
  }

  for (const w of (data ?? []) as WalletRow[]) {
    if (swept.length >= maxSweeps) break
    if (w.deposit_index == null || !w.deposit_address) continue
    scanned++

    try {
      const bal = (await cngnRead.balanceOf(w.deposit_address)) as bigint
      if (bal < minSweep) continue

      const signer = deriveDepositSigner(Number(w.deposit_index), provider)
      const cngn   = new ethers.Contract(CONTRACTS.CNGN, ERC20_ABI, signer)

      // Ensure the address can pay gas for one ERC-20 transfer.
      const gasLimit = await cngn.transfer.estimateGas(destination, bal).catch(() => 80_000n)
      const fee      = await provider.getFeeData()
      const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000n
      const needed   = (gasLimit * gasPrice * 13n) / 10n // +30% buffer
      const have     = await provider.getBalance(w.deposit_address)
      if (have < needed) {
        const top = await funder.sendTransaction({ to: w.deposit_address, value: needed - have })
        await top.wait()
      }

      const tx = await cngn.transfer(destination, bal)
      await tx.wait()
      swept.push({
        userId: w.user_id,
        address: w.deposit_address,
        amountCngnMicro: bal.toString(),
        txHash: tx.hash,
      })
    } catch (e: unknown) {
      const err = e as { shortMessage?: string; message?: string }
      skipped.push({ address: w.deposit_address, error: err?.shortMessage || err?.message || "sweep failed" })
    }
  }

  return { swept, skipped, scanned }
}