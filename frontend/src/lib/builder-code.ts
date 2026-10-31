import { ethers } from 'ethers'

/**
 * Base Builder Code attribution (ERC-8021).
 *
 * Base credits onchain activity to an app when each transaction's calldata ends
 * with an ERC-8021 suffix carrying the app's Builder Code. PawaSave sends its Base
 * transactions from server-held signers (custody, keepers, sweeps), so the suffix
 * is appended here rather than by a browser wallet.
 *
 * Set BASE_BUILDER_CODE to the code from Base Dashboard > Settings > Project
 * Settings > Builder Code (it looks like `bc_b7k3p9da`). Unset or invalid means
 * attribution is off and every transaction goes out unchanged.
 *
 * Suffix layout, read forwards: the code as ASCII, a 1-byte length, a 1-byte
 * schema id (0), then the 16-byte marker 0x8021…8021. Base's docs give
 * `bc_b7k3p9da` → 0x62635f62376b33703964610b0080218021802180218021802180218021.
 */

const MARKER = '80218021802180218021802180218021'
const SCHEMA_ID = '00'
/** Base mainnet and Base Sepolia. Other chains (Arbitrum, BNB deposit sweeps) are left untouched. */
const BASE_CHAIN_IDS = new Set<bigint>([8453n, 84532n])

/** The ERC-8021 data suffix for a Builder Code, or null when none is configured or the code is invalid. */
export function builderCodeSuffix(code: string | undefined = process.env.BASE_BUILDER_CODE): string | null {
  const c = (code ?? '').trim()
  // Printable ASCII only, no commas (schema 0 separates multiple codes with commas), 1–255 bytes.
  if (!c || c.length > 255 || !/^[\x21-\x7e]+$/.test(c) || c.includes(',')) return null
  const codeHex = Buffer.from(c, 'ascii').toString('hex')
  const lenHex = c.length.toString(16).padStart(2, '0')
  return `0x${codeHex}${lenHex}${SCHEMA_ID}${MARKER}`
}

/**
 * Append the suffix to contract-call calldata. Plain value transfers (empty data)
 * are left alone, because sending calldata to a contract with only a receive()
 * function would revert. Data that already ends in the marker is not suffixed twice.
 */
export function withBuilderCode(data: string | null | undefined, suffix: string | null): string | null | undefined {
  if (!suffix || !data || data === '0x') return data
  if (data.toLowerCase().endsWith(MARKER)) return data
  return data + suffix.slice(2)
}

/**
 * Drop-in replacement for `new ethers.Wallet(key, provider)` that attributes every
 * Base contract call it sends to PawaSave's Builder Code. Contracts connected to
 * this signer go through sendTransaction, so `contract.method(...)` is covered too.
 * Solidity's ABI decoder ignores trailing calldata, so the extra bytes do not
 * change what the call does.
 */
export class AttributedWallet extends ethers.Wallet {
  override async sendTransaction(tx: ethers.TransactionRequest): Promise<ethers.TransactionResponse> {
    const suffix = builderCodeSuffix()
    if (suffix && tx.data && this.provider) {
      const { chainId } = await this.provider.getNetwork()
      if (BASE_CHAIN_IDS.has(chainId)) {
        tx = { ...tx, data: withBuilderCode(ethers.hexlify(tx.data), suffix) }
      }
    }
    return super.sendTransaction(tx)
  }
}
