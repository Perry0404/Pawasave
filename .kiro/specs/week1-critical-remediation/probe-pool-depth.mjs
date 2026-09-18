// Task 6. Resolve the pool depth contradiction in equity-broker.ts.
//
// The file claims two incompatible things about the same B20 pools:
//   :52-58   Aerodrome Slipstream holds "$1M+ each, ~flat price even at $3k"
//   :104-110 enable-time depths of roughly $5k for SNDK/SPCX/MSFT/MSTR/TSLA
//
// Both cannot be true. This quotes real trades at increasing sizes against the same
// quoters the broker uses, and reports the price per share at each. A deep pool holds
// a flat price. A thin pool's price climbs steeply with size.
//
// Run from the repo root:  node .kiro/specs/week1-critical-remediation/probe-pool-depth.mjs

import { ethers } from 'ethers'

const RPC = process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/OZw8WLV7kp2R3T6F7oUak'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// Same addresses and candidate lists the broker uses.
const UNIV3_QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a'
const AERO_QUOTER = '0x514c8B5f54112481E28028F1166Bd78501089259'
const FEE_TIERS = [3000, 500, 10000, 100]
const TICK_SPACINGS = [10, 50, 100, 200, 1, 2000]

const QUOTER_ABI = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)']
const AERO_ABI = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)']

const STOCKS = {
  AAPL: '0xb200000000000000000000C2e324d24d7eEcd1fb',
  NVDA: '0xb20000000000000000000078ee7ce2fE4908108C',
  META: '0xb2000000000000000000008bC8786B856E61707C',
  GOOGL: '0xb2000000000000000000002D0BA3164cc74f58B7',
  AMZN: '0xb200000000000000000000d9192b6B456483C2E8',
  MSFT: '0xB200000000000000000000Ab99cFa739E253872B',
  MSTR: '0xb2000000000000000000004884b426556b92883d',
  SNDK: '0xb200000000000000000000397293Cb8cda9a10c5',
  SPCX: '0xb2000000000000000000007b9fcbd005511aCBd5',
  TSLA: '0xb2000000000000000000001e800a7f5189430cD0',
}

const SIZES_USD = [10, 100, 1000, 3000]
const provider = new ethers.JsonRpcProvider(RPC, 8453)
const uni = new ethers.Contract(UNIV3_QUOTER, QUOTER_ABI, provider)
const aero = new ethers.Contract(AERO_QUOTER, AERO_ABI, provider)

// Best quote across both venues, mirroring swapBestVenue.
async function bestOut(token, amountIn) {
  let best = 0n
  for (const fee of FEE_TIERS) {
    try {
      const q = await uni.quoteExactInputSingle.staticCall({
        tokenIn: USDC, tokenOut: token, amountIn, fee, sqrtPriceLimitX96: 0,
      })
      if (BigInt(q[0]) > best) best = BigInt(q[0])
    } catch { /* no pool at this tier */ }
  }
  for (const tickSpacing of TICK_SPACINGS) {
    try {
      const q = await aero.quoteExactInputSingle.staticCall({
        tokenIn: USDC, tokenOut: token, amountIn, tickSpacing, sqrtPriceLimitX96: 0,
      })
      if (BigInt(q[0]) > best) best = BigInt(q[0])
    } catch { /* no CL pool at this tickSpacing */ }
  }
  return best
}

console.log(`\nUSDC -> stock, price per share at increasing order size`)
console.log(`Slippage is measured against the $10 quote, which is effectively spot.\n`)
console.log(`${'SYM'.padEnd(6)}${SIZES_USD.map((s) => `$${s}`.padStart(13)).join('')}   slip@$1k  slip@$3k  verdict`)

for (const [sym, token] of Object.entries(STOCKS)) {
  const prices = []
  for (const usd of SIZES_USD) {
    const out = await bestOut(token, BigInt(usd) * 1_000_000n)
    // shares are 8 decimals, so price per share = usd / (out / 1e8)
    prices.push(out === 0n ? null : usd / (Number(out) / 1e8))
  }

  const [p10, , p1k, p3k] = prices
  const slip = (p) => (p == null || p10 == null ? null : ((p - p10) / p10) * 100)
  const s1k = slip(p1k)
  const s3k = slip(p3k)

  let verdict = 'no route'
  if (p10 != null) {
    if (s3k != null && s3k < 2) verdict = 'DEEP, flat to $3k'
    else if (s1k != null && s1k < 2) verdict = 'ok to $1k, degrades above'
    else if (s1k != null && s1k < 15) verdict = 'THIN, real impact at $1k'
    else verdict = 'VERY THIN'
  }

  const cells = prices.map((p) => (p == null ? '-'.padStart(13) : p.toFixed(2).padStart(13))).join('')
  const f = (v) => (v == null ? '     -' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`.padStart(9))
  console.log(`${sym.padEnd(6)}${cells}${f(s1k)}${f(s3k)}  ${verdict}`)
}

console.log(`
Reading this:
  A flat price across all four columns means the deep-pool claim is right.
  A price that climbs with size means the ~$5k claim is right and the buy path needs
  both a per-order ceiling and the fair-value floor it currently lacks.
`)
