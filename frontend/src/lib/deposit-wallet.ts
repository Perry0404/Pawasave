/**
 * deposit-wallet.ts — per-user deposit address derivation (SERVER ONLY).
 *
 * Each user's wallet has a stable `deposit_index`. Their personal Base deposit
 * address is derived from one master mnemonic at BIP-44 path
 * m/44'/60'/0'/0/{index}. PawaSave controls the keys, so funds can be swept to
 * custody; the scanner credits incoming cNGN automatically.
 *
 * The mnemonic is resolved via `getSecret` — AWS Secrets Manager when configured
 * (DEPOSIT_WALLET_MNEMONIC inside AWS_SECRETS_ID), otherwise the env var.
 *
 * NEVER import this into a client component — it reads the master seed.
 */
import { HDNodeWallet, JsonRpcProvider } from "ethers"
import { getSecret } from "./secrets"

let cachedMnemonic: string | null = null

async function mnemonic(): Promise<string> {
  if (cachedMnemonic !== null) return cachedMnemonic
  cachedMnemonic = (await getSecret("DEPOSIT_WALLET_MNEMONIC")) || ""
  return cachedMnemonic
}

function isConfigured(m: string): boolean {
  return m.trim().split(/\s+/).length >= 12
}

function pathFor(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error("Invalid deposit index")
  return `m/44'/60'/0'/0/${index}`
}

export async function depositWalletConfigured(): Promise<boolean> {
  return isConfigured(await mnemonic())
}

/** Derive the deposit address for a given index. */
export async function deriveDepositAddress(index: number): Promise<string> {
  const m = await mnemonic()
  if (!isConfigured(m)) throw new Error("DEPOSIT_WALLET_MNEMONIC not configured")
  return HDNodeWallet.fromPhrase(m, undefined, pathFor(index)).address
}

/** Derive a signer for a deposit address (for sweeping to custody). */
export async function deriveDepositSigner(index: number, provider: JsonRpcProvider) {
  const m = await mnemonic()
  if (!isConfigured(m)) throw new Error("DEPOSIT_WALLET_MNEMONIC not configured")
  return HDNodeWallet.fromPhrase(m, undefined, pathFor(index)).connect(provider)
}