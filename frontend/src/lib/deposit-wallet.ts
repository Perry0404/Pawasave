/**
 * deposit-wallet.ts — per-user deposit address derivation (SERVER ONLY).
 *
 * Each user's wallet has a stable `deposit_index`. Their personal Base deposit
 * address is derived from one master mnemonic (DEPOSIT_WALLET_MNEMONIC) at
 * BIP-44 path m/44'/60'/0'/0/{index}. PawaSave controls the keys, so funds can
 * later be swept to custody; the scanner credits incoming cNGN automatically.
 *
 * NEVER import this into a client component — it reads the master seed.
 *
 * Required env var:
 *   DEPOSIT_WALLET_MNEMONIC — 12/24-word seed phrase for the deposit HD wallet
 */
import { HDNodeWallet, JsonRpcProvider } from "ethers"

const MNEMONIC = process.env.DEPOSIT_WALLET_MNEMONIC || ""

export function depositWalletConfigured(): boolean {
  return MNEMONIC.trim().split(/\s+/).length >= 12
}

function pathFor(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error("Invalid deposit index")
  return `m/44'/60'/0'/0/${index}`
}

/** Derive the deposit address for a given index. */
export function deriveDepositAddress(index: number): string {
  if (!depositWalletConfigured()) throw new Error("DEPOSIT_WALLET_MNEMONIC not configured")
  return HDNodeWallet.fromPhrase(MNEMONIC, undefined, pathFor(index)).address
}

/** Derive a signer for a deposit address (for future sweeping to custody). */
export function deriveDepositSigner(index: number, provider: JsonRpcProvider) {
  if (!depositWalletConfigured()) throw new Error("DEPOSIT_WALLET_MNEMONIC not configured")
  return HDNodeWallet.fromPhrase(MNEMONIC, undefined, pathFor(index)).connect(provider)
}
