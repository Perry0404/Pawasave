/**
 * Groups custody's HyperFX activity by transaction so each intent order can be read as
 * one row: what went into the gateway, and whether anything came back.
 * Read-only. Run: node scripts/forensics-hyperfx-orders.mjs
 */
import { ethers } from 'ethers'

const RPC = process.env.BASE_WRITE_RPC_URL
const CUSTODY = '0xabc8c660f6d217812d57c22db10c765fc63f4b5d'
const GATEWAY = '0xae041f7b0cb581876832830baeb6a2aa2a3c9716'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const CNGN = '0x46c85152bfe9f96829aa94755d9f915f9b10ef5f'
const NAMES = { [USDC]: 'USDC', [CNGN]: 'cNGN' }

const provider = new ethers.JsonRpcProvider(RPC, 8453)
const fmt = (v) => (Number(v) / 1e6).toFixed(4)

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}

async function transfers(key, addr, fromBlock) {
  const all = []
  let pageKey
  do {
    const res = await rpc('alchemy_getAssetTransfers', [{
      fromBlock: ethers.toBeHex(fromBlock), toBlock: 'latest', [key]: addr,
      category: ['erc20'], contractAddresses: [ethers.getAddress(USDC), ethers.getAddress(CNGN)],
      withMetadata: true, maxCount: '0x3e8', ...(pageKey ? { pageKey } : {}),
    }])
    all.push(...res.transfers)
    pageKey = res.pageKey
  } while (pageKey)
  return all
}

async function main() {
  const head = await provider.getBlockNumber()
  const from = head - 300_000

  const [out, inn] = await Promise.all([
    transfers('fromAddress', CUSTODY, from),
    transfers('toAddress', CUSTODY, from),
  ])

  const byTx = new Map()
  const put = (t, dir) => {
    const e = byTx.get(t.hash) || { hash: t.hash, ts: t.metadata?.blockTimestamp, block: t.blockNum, legs: [] }
    e.legs.push({
      dir, token: NAMES[(t.rawContract?.address ?? '').toLowerCase()] ?? '?',
      amount: BigInt(t.rawContract?.value ?? '0x0'),
      other: (dir === 'out' ? t.to : t.from)?.toLowerCase(),
    })
    byTx.set(t.hash, e)
  }
  out.forEach((t) => put(t, 'out'))
  inn.forEach((t) => put(t, 'in'))

  const txs = [...byTx.values()].sort((a, b) => Number(a.block) - Number(b.block))

  console.log('Every custody erc20 transaction, oldest first.')
  console.log('"gateway" means the HyperFX IntentGateway at 0xae041f7b.\n')

  let escrowUsdc = 0n, escrowCngn = 0n, feeUsdc = 0n
  const orders = []

  for (const t of txs) {
    const toGw = t.legs.filter((l) => l.dir === 'out' && l.other === GATEWAY)
    if (toGw.length === 0) continue

    // The larger leg is the order input, the small one is the solver fee in USDC.
    const usdcLegs = toGw.filter((l) => l.token === 'USDC').sort((a, b) => Number(b.amount - a.amount))
    const cngnLegs = toGw.filter((l) => l.token === 'cNGN')
    let input, fee
    if (cngnLegs.length) {
      input = { token: 'cNGN', amount: cngnLegs.reduce((s, l) => s + l.amount, 0n) }
      fee = usdcLegs.reduce((s, l) => s + l.amount, 0n)
    } else {
      input = { token: 'USDC', amount: usdcLegs[0]?.amount ?? 0n }
      fee = usdcLegs.slice(1).reduce((s, l) => s + l.amount, 0n)
    }
    if (input.token === 'cNGN') escrowCngn += input.amount
    else escrowUsdc += input.amount
    feeUsdc += fee

    const back = t.legs.filter((l) => l.dir === 'in')
    orders.push({ ts: t.ts, hash: t.hash, dir: input.token === 'cNGN' ? 'cngn->usdc' : 'usdc->cngn', input, fee, back })
  }

  for (const o of orders) {
    const sameTxBack = o.back.length
      ? o.back.map((l) => `${fmt(l.amount)} ${l.token}`).join(', ')
      : 'nothing in this tx'
    console.log(
      `${o.ts}  ${o.dir}  in ${fmt(o.input.amount).padStart(11)} ${o.input.token}  fee ${fmt(o.fee)} USDC  back: ${sameTxBack}`,
    )
    console.log(`    ${o.hash}`)
  }

  console.log(`\n${orders.length} intent orders placed`)
  console.log(`escrowed into the gateway: ${fmt(escrowCngn)} cNGN, ${fmt(escrowUsdc)} USDC`)
  console.log(`solver fees paid:          ${fmt(feeUsdc)} USDC`)

  console.log('\nEverything custody received, oldest first, so fills and refunds are visible.\n')
  for (const t of inn.sort((a, b) => Number(a.blockNum) - Number(b.blockNum))) {
    const token = NAMES[(t.rawContract?.address ?? '').toLowerCase()] ?? '?'
    const amt = BigInt(t.rawContract?.value ?? '0x0')
    console.log(`  ${t.metadata?.blockTimestamp}  ${token}  ${fmt(amt).padStart(11)}  from ${t.from}`)
  }

  const gwUsdc = new ethers.Contract(ethers.getAddress(USDC), ['function balanceOf(address) view returns (uint256)'], provider)
  const gwCngn = new ethers.Contract(ethers.getAddress(CNGN), ['function balanceOf(address) view returns (uint256)'], provider)
  console.log(`\ngateway total holdings: ${fmt(await gwUsdc.balanceOf(GATEWAY))} USDC, ${fmt(await gwCngn.balanceOf(GATEWAY))} cNGN`)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
