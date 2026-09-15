/**
 * Measures the gap between what we credit customers for a Strails deposit and what actually
 * arrives in custody.
 *
 * Why this cannot live in the webhook: the webhook credits amountNgn minus our fee, but the
 * cNGN lands in custody separately and asynchronously, and nothing in the database records
 * the arrival. crypto_deposits only covers on-chain deposits to per-user addresses, and
 * Strails pays custody directly. So the two halves only meet here.
 *
 * Read-only. Needs BASE_WRITE_RPC_URL, and the Supabase URL plus service role key to read
 * the credited side. Without those it reports the on-chain side alone.
 *
 * Run: node scripts/forensics-deposit-shortfall.mjs
 */
import { ethers } from 'ethers'

const RPC = process.env.BASE_WRITE_RPC_URL || process.env.BASE_MAINNET_RPC_URL
const CUSTODY = (process.env.FLIPEET_CUSTODY_ADDRESS || '0xaBc8c660F6d217812D57c22db10c765fC63F4B5d').toLowerCase()
const CNGN = '0x46C85152bFe9f96829aA94755D9f915F9B10EF5F'

// Inbound cNGN that is our own money moving, not a customer deposit.
const LEND = '0x5583802fb2215d550f80dc42cd44c40e0ef8b7cf'     // pool redemption
const GATEWAY = '0xae041f7b0cb581876832830baeb6a2aa2a3c9716'  // intent gateway refund

/**
 * A solver paying out a USDC to cNGN fill also sends cNGN to custody, and it arrives from an
 * ordinary address, so an address filter cannot separate it from a deposit. Matching each
 * credited deposit to the arrival nearest in time is what keeps those out of the total.
 */
const MATCH_WINDOW_MS = 12 * 60 * 1000

const provider = new ethers.JsonRpcProvider(RPC, 8453)
const ngn = (micro) => (Number(micro) / 1e6).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}

async function main() {
  if (!RPC) throw new Error('set BASE_WRITE_RPC_URL')
  const head = await provider.getBlockNumber()

  // Every cNGN arrival into custody. Exclude the pool and the intent gateway, which are our
  // own money moving, not customer deposits.
  const res = await rpc('alchemy_getAssetTransfers', [{
    fromBlock: '0x0', toBlock: 'latest', toAddress: CUSTODY,
    category: ['erc20'], contractAddresses: [CNGN],
    withMetadata: true, maxCount: '0x3e8',
  }])

  const arrivals = res.transfers
    .filter((t) => {
      const from = (t.from ?? '').toLowerCase()
      return from !== LEND && from !== GATEWAY
    })
    .map((t) => ({
      ts: t.metadata?.blockTimestamp,
      micro: BigInt(t.rawContract?.value ?? '0x0'),
      from: t.from,
      hash: t.hash,
    }))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1))

  const onchainTotal = arrivals.reduce((s, a) => s + a.micro, 0n)

  console.log(`custody ${CUSTODY}`)
  console.log(`head block ${head}\n`)
  console.log(`cNGN arrivals that look like customer deposits: ${arrivals.length}`)
  console.log(`total received on chain: ${ngn(onchainTotal)} cNGN\n`)
  for (const a of arrivals) {
    console.log(`  ${a.ts}  ${ngn(a.micro).padStart(12)}  from ${a.from}`)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log('\nSet NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to compare against')
    console.log('what was credited. On-chain side only for now.')
    return
  }

  const { createClient } = await import('@supabase/supabase-js')
  const db = createClient(url, key, { auth: { persistSession: false } })
  const { data: rows, error } = await db
    .from('transactions')
    .select('amount_usdc_micro,amount_kobo,metadata,created_at,reference')
    .eq('type', 'deposit')
    .eq('direction', 'credit')
    .eq('status', 'completed')
  if (error) throw new Error(error.message)

  const strails = (rows ?? [])
    .filter((r) => r.metadata?.channel === 'Strails')
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))

  // Pair each credit with the closest unclaimed arrival, so solver fills and pool
  // redemptions cannot be mistaken for deposit funding.
  const unclaimed = [...arrivals]
  const pairs = []
  for (const r of strails) {
    const t = new Date(r.created_at).getTime()
    let best = -1
    let bestGap = Infinity
    unclaimed.forEach((a, i) => {
      const d = Math.abs(new Date(a.ts).getTime() - t)
      if (d < bestGap) { bestGap = d; best = i }
    })
    const matched = best >= 0 && bestGap <= MATCH_WINDOW_MS ? unclaimed.splice(best, 1)[0] : null
    pairs.push({ credit: r, arrival: matched, gapMs: matched ? bestGap : null })
  }

  console.log(`\n${strails.length} Strails deposits credited, matched within ${MATCH_WINDOW_MS / 60000} minutes\n`)
  let creditedMatched = 0n
  let receivedMatched = 0n
  let unmatched = 0
  for (const p of pairs) {
    const c = BigInt(p.credit.amount_usdc_micro ?? 0)
    if (!p.arrival) {
      unmatched++
      console.log(`  ${p.credit.created_at}  credited ${ngn(c).padStart(11)}  NO ARRIVAL FOUND`)
      continue
    }
    creditedMatched += c
    receivedMatched += p.arrival.micro
    const d = c - p.arrival.micro
    console.log(
      `  ${p.credit.created_at}  credited ${ngn(c).padStart(11)}` +
      `  received ${ngn(p.arrival.micro).padStart(11)}` +
      `  gap ${ngn(d).padStart(9)}`,
    )
  }

  const gap = creditedMatched - receivedMatched
  console.log(`\n  matched deposits          : ${pairs.length - unmatched}`)
  if (unmatched) console.log(`  unmatched, excluded       : ${unmatched}`)
  console.log(`  credited to customers     : ${ngn(creditedMatched)}`)
  console.log(`  received in custody       : ${ngn(receivedMatched)}`)
  console.log(`  shortfall                 : ${ngn(gap)} cNGN`)
  const n = pairs.length - unmatched
  if (n > 0) {
    console.log(`  average per deposit       : ${ngn(gap / BigInt(n))}`)
    console.log('\nIf the average is roughly constant regardless of deposit size then this is a')
    console.log('flat per-transfer cost, which hurts small deposits far more than large ones.')
  }
  console.log('\nA positive shortfall means we credited customers more than the provider')
  console.log('actually delivered, and the difference comes out of company float.')
}

main().catch((e) => { console.error(e.message); process.exit(1) })
