/**
 * hyperfx.ts — cNGN ⇄ USDC conversion via the Hyperbridge (HyperFX) Intent Gateway.
 *
 * The problem this solves: cNGN has ~zero on-chain DEX liquidity (the Uniswap/Aerodrome
 * cNGN pools are empty shells), so cNGN cannot be swapped to USD on any Base DEX, and the
 * public aggregators (Odos/KyberSwap) block our datacenter IP. HyperFX routes around both:
 * it is an intent settlement layer where SOLVERS provide the output liquidity. Hyperbridge
 * ships a first-class USDC/cNGN pair (configService.getCNgnAsset + a built-in quote), so a
 * cNGN→USDC (or USDC→cNGN) order is filled by whichever solver holds the other side —
 * exactly the "user pays cNGN, HyperFX converts, then we buy the stock" flow, and the same
 * rail the Daya USDT→cNGN liquidity deal plugs into (Daya = the cNGN-side solver/filler).
 *
 * We run SAME-CHAIN (Base→Base): custody escrows the input on Base, a solver fills the
 * output on Base atomically. Nothing here trusts a quote — the caller measures the real
 * balance delta after FILLED.
 *
 * STAYS DARK until ALL of these hold (mirrors STRAILS_ENABLED / GETEQUITY_ENABLED):
 *   HYPERFX_ENABLED=true
 *   deps installed:   npm i @hyperbridge/sdk viem     (kept as OPTIONAL server externals so
 *                     the app still builds before they're added — see next.config.js)
 *   HYPERFX_BUNDLER_URL   ERC-4337 bundler for Base (solvers submit fills as UserOperations)
 *   custody wallet funded with native ETH (gas) + the Hyperbridge fee token (solver fee)
 * Until then every call throws a clear, caught error — the equity buy simply refunds.
 *
 * A fill also depends on a SOLVER actually taking the cNGN→USDC side; if none bids the
 * order expires (caught → refund). That liquidity is the Daya/HyperFX partnership, not code.
 *
 * Optional env:
 *   HYPERFX_COPROCESSOR_WS  (default wss://nexus.rpc.polytope.technology)
 *   HYPERFX_INDEXER_URL     (default https://nexus.indexer.polytope.technology)
 *   HYPERFX_AUCTION_MS      solver auction window (default 15000)
 *   HYPERFX_GRAFFITI        integrator attribution tag (default 'pawasave')
 */

import { ethers } from 'ethers'
import { CONTRACTS } from './contracts'
import { getSecret } from './secrets'
import { cngnBalanceOf } from './custody'

export const HYPERFX_ENABLED = process.env.HYPERFX_ENABLED === 'true'

const COPROCESSOR_WS = process.env.HYPERFX_COPROCESSOR_WS || 'wss://nexus.rpc.polytope.technology'
const INDEXER_URL = process.env.HYPERFX_INDEXER_URL || 'https://nexus.indexer.polytope.technology'
const AUCTION_MS = Number(process.env.HYPERFX_AUCTION_MS) || 15_000

function rpcUrl(): string {
  const u = process.env.BASE_WRITE_RPC_URL || process.env.BASE_MAINNET_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL
  if (!u) throw new Error('HyperFX: no Base RPC (set BASE_WRITE_RPC_URL)')
  return u
}
function bundlerUrl(): string {
  const u = process.env.HYPERFX_BUNDLER_URL
  if (!u) throw new Error('HyperFX: HYPERFX_BUNDLER_URL (ERC-4337 bundler) not configured')
  return u
}

/**
 * Load the optional deps at runtime. They are declared as server externals (next.config.js)
 * so a build BEFORE they're installed still succeeds; here a missing module surfaces as a
 * clear, caught error instead of a build failure. Typed `any` — no @types at dark time.
 */
async function loadDeps(): Promise<{ sdk: any; viem: any; viemAccounts: any; baseChain: any }> {
  try {
    // @ts-ignore optional dependency, resolved at runtime once installed
    const sdk: any = await import('@hyperbridge/sdk')
    // @ts-ignore optional dependency, resolved at runtime once installed
    const viem: any = await import('viem')
    // @ts-ignore optional dependency, resolved at runtime once installed
    const viemAccounts: any = await import('viem/accounts')
    // @ts-ignore optional dependency, resolved at runtime once installed
    const viemChains: any = await import('viem/chains')
    return { sdk, viem, viemAccounts, baseChain: viemChains.base }
  } catch (e) {
    throw new Error('HyperFX deps not installed — run: npm i @hyperbridge/sdk viem')
  }
}

async function custodyAccount(viemAccounts: any) {
  const key = await getSecret('CUSTODY_PRIVATE_KEY')
  if (!key) throw new Error('CUSTODY_PRIVATE_KEY not configured')
  return viemAccounts.privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
}

/** ERC-20 (micro) balance of an address on Base — the delta source of truth after a fill. */
async function tokenBalance(token: string, holder: string): Promise<bigint> {
  if (token.toLowerCase() === CONTRACTS.CNGN.toLowerCase()) return cngnBalanceOf(holder)
  const provider = new ethers.JsonRpcProvider(rpcUrl(), 8453)
  const c = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)'], provider)
  return BigInt(await c.balanceOf(holder))
}

type Direction = 'cngn->usdc' | 'usdc->cngn'

/**
 * Convert `amountInMicro` of the input asset into the output asset, same-chain on Base,
 * via one HyperFX intent that custody signs and a solver fills. Returns the amount of the
 * OUTPUT asset that actually landed in custody (measured on-chain, not the quote). Throws
 * on no-bid / expiry / any failure so the caller can refund.
 */
async function convert(direction: Direction, amountInMicro: bigint): Promise<bigint> {
  if (!HYPERFX_ENABLED) throw new Error('HyperFX is disabled (HYPERFX_ENABLED not set)')
  if (amountInMicro <= 0n) throw new Error('HyperFX: zero amount')

  const { sdk, viem, viemAccounts, baseChain } = await loadDeps()
  const {
    EvmChain, IntentGateway, IntentsCoprocessor, createQueryClient, IntentOrderStatus,
  } = sdk

  const RPC = rpcUrl()
  const chain = await EvmChain.create(RPC, bundlerUrl()) // same-chain: source === dest
  const coprocessor = await IntentsCoprocessor.connect(COPROCESSOR_WS)
  const queryClient = createQueryClient({ url: INDEXER_URL })
  const gateway = (await IntentGateway.create(chain, chain, coprocessor)).withQueryClient(queryClient)

  const account = await custodyAccount(viemAccounts)
  // `chain` is required so viem can fill chainId/gas/nonce when signing locally.
  const walletClient = viem.createWalletClient({ account, chain: baseChain, transport: viem.http(RPC) })

  const id = chain.config.stateMachineId
  const usdc = chain.configService.getUsdcAsset(id)
  const cngn = chain.configService.getCNgnAsset(id)
  if (!cngn) throw new Error(`HyperFX: cNGN is not configured on ${id}`)
  const [tokenIn, tokenOut] = direction === 'cngn->usdc' ? [cngn, usdc] : [usdc, cngn]

  const quote = await gateway.quoteIntent({ tokenIn, tokenOut, amountIn: amountInMicro })

  const order: any = {
    user: viem.zeroHash,
    source: id,
    destination: id,
    deadline: (await chain.client.getBlockNumber()) + 200n,
    nonce: 0n,
    fees: 0n,
    session: viem.zeroAddress,
    predispatch: { assets: [], call: '0x' },
    inputs: [{ token: tokenIn, amount: quote.amountIn }],
    output: { beneficiary: account.address, assets: [{ token: tokenOut, amount: quote.amountOut }], call: '0x' },
  }

  // Solver fee — pay it DIRECTLY in the fee token (USDC on Base), not native ETH. The
  // native path makes placeOrder swap ETH→feeToken via a UniswapV2 router that reverts
  // unreliably on Base (its factory() even reverts). Paying the fee token via allowance
  // hits the gateway's deterministic safeTransferFrom branch — no swap. Custody must hold
  // a small USDC buffer for fees (msg.value stays 0 so the gateway takes that branch).
  const { fees, feeToken } = await gateway.quoteOrderFees(order)
  order.fees = fees
  const gatewayAddr = chain.configService.getIntentGatewayAddress(id)

  // Approve the input token (gross) + the exact fee token to the gateway.
  await walletClient.writeContract({ address: tokenIn, abi: viem.erc20Abi, functionName: 'approve', args: [gatewayAddr, quote.amountIn] })
    .then((h: string) => chain.client.waitForTransactionReceipt({ hash: h }))
  if (fees > 0n) {
    await walletClient.writeContract({ address: feeToken, abi: viem.erc20Abi, functionName: 'approve', args: [gatewayAddr, fees] })
      .then((h: string) => chain.client.waitForTransactionReceipt({ hash: h }))
  }

  const before = await tokenBalance(tokenOut, account.address)

  // executeBest is a bidirectional generator: it hands us the placeOrder calldata, we sign
  // and hand back the signed tx, then it runs the solver auction + submits the fill.
  const run = gateway.executeBest(order, viem.padHex(viem.stringToHex(process.env.HYPERFX_GRAFFITI || 'pawasave'), { size: 32, dir: 'right' }), {
    auctionTimeMs: AUCTION_MS, pollIntervalMs: 5_000,
  })
  const first = await run.next()
  if (first.done || first.value.status !== IntentOrderStatus.AWAITING_PLACE_ORDER) {
    throw new Error('HyperFX: expected placement transaction')
  }
  const { to, data, value } = first.value
  // viem's signTransaction does NOT populate nonce/gas/fees — it signs exactly what it
  // is given, so signing the raw {to,data,value} produced a tx with gasLimit/fees = 0
  // that Alchemy rejects ("invalid parameters"). prepareTransactionRequest fills nonce,
  // gas estimate, and EIP-1559 fees first. msg.value stays as the order's native input
  // (0 for an ERC-20 input) so the gateway pays the fee from the USDC allowance, not a swap.
  const prepared = await walletClient.prepareTransactionRequest({
    account, chain: baseChain, to, data, value: BigInt(value ?? 0n),
  })
  const signed = await walletClient.signTransaction(prepared)
  const placed = await run.next(signed)
  if (placed.done || placed.value.status !== IntentOrderStatus.ORDER_PLACED) {
    throw new Error('HyperFX: order was not placed')
  }

  let filled = false
  for await (const update of run) {
    if (update.status === IntentOrderStatus.FILLED) { filled = true; break }
    if (update.status === IntentOrderStatus.EXPIRED) throw new Error('HyperFX: order expired (no solver filled)')
    // PARTIAL_FILL / AWAITING_BIDS / BID_SELECTED / retryable FAILED — keep waiting.
  }
  if (!filled) throw new Error('HyperFX: order did not fill')

  const received = (await tokenBalance(tokenOut, account.address)) - before
  if (received <= 0n) throw new Error('HyperFX: filled but no output received')
  return received
}

/** cNGN (micro) → USDC (micro), returning USDC actually received into custody. */
export function convertCngnToUsdc(cngnMicro: bigint): Promise<bigint> {
  return convert('cngn->usdc', cngnMicro)
}

/** USDC (micro) → cNGN (micro), returning cNGN actually received into custody. */
export function convertUsdcToCngn(usdcMicro: bigint): Promise<bigint> {
  return convert('usdc->cngn', usdcMicro)
}
