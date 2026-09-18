/**
 * Reads what custody actually sent to the HyperFX IntentGateway and what came back.
 * Uses alchemy_getAssetTransfers because the free tier caps eth_getLogs at 10 blocks.
 * Read-only. Run: node scripts/forensics-hyperfx-escrow.mjs
 */
import { ethers } from 'ethers'

const RPC = process.env.BASE_WRITE_RPC_URL || process.env.BASE_RPC_URL
const CUSTODY = (process.env.CUSTODY_ADDRESS || '0xaBc8c660F6d217812D57c22db10c765fC63F4B5d').toLowerCase()

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const CNGN = '0x46C85152bFe9f96829aA94755D9f915F9B10EF5F'
const NAMES = { [USDC.toLowerCase()]: 'USDC', [CNGN.toLowerCase()]: 'cNGN' }

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
]

const provider = new ethers.JsonRpcProvider(RPC, 8453)
const fmt = (v) => (Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 4 })

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

async function transfers(direction, fromBlock) {
  const key = direction === 'out' ? 'fromAddress' : 'toAddress'
  const all = []
  let pageKey
  do {
    const res = await rpc('alchemy_getAssetTransfers', [{
      fromBlock: ethers.toBeHex(fromBlock),
      toBlock: 'latest',
      [key]: CUSTODY,
      category: ['erc20'],
      contractAddresses: [USDC, CNGN],
      withMetadata: true,
      maxCount: '0x3e8',
      ...(pageKey ? { pageKey } : {}),
    }])
    all.push(...res.transfers)
    pageKey = res.pageKey
  } while (pageKey)
  return all
}

async function main() {
  const head = await provider.getBlockNumber()
  console.log(`Base head block ${head}`)
  console.log(`custody ${CUSTODY}\n`)

  console.log(`custody ETH   ${ethers.formatEther(await provider.getBalance(CUSTODY))}`)
  for (const [name, addr] of [['USDC', USDC], ['cNGN', CNGN]]) {
    const c = new ethers.Contract(addr, ERC20, provider)
    console.log(`custody ${name}  ${fmt(await c.balanceOf(CUSTODY))}`)
  }

  const from = head - 300_000 // roughly a week of Base blocks
  const [out, inn] = await Promise.all([transfers('out', from), transfers('in', from)])
  console.log(`\n${out.length} outbound, ${inn.length} inbound erc20 transfers since block ${from}\n`)

  const parties = new Map()
  const bump = (addr, token, field, raw) => {
    const k = `${token}|${addr}`
    const e = parties.get(k) || { token, addr, sent: 0n, sentN: 0, recv: 0n, recvN: 0 }
    e[field] += raw
    e[field === 'sent' ? 'sentN' : 'recvN']++
    parties.set(k, e)
  }
  const raw = (t) => BigInt(t.rawContract?.value ?? '0x0')
  const tok = (t) => NAMES[(t.rawContract?.address ?? '').toLowerCase()] ?? '?'

  for (const t of out) bump(t.to?.toLowerCase(), tok(t), 'sent', raw(t))
  for (const t of inn) bump(t.from?.toLowerCase(), tok(t), 'recv', raw(t))

  console.log('Net per counterparty, positive net means custody is down that much\n')
  const rows = [...parties.values()].sort((a, b) => Number(b.sent - b.recv) - Number(a.sent - a.recv))
  for (const r of rows) {
    const isContract = (await provider.getCode(r.addr)) !== '0x'
    console.log(
      `${r.token.padEnd(5)} ${r.addr} ${isContract ? 'contract' : 'wallet  '} ` +
      `sent ${fmt(r.sent).padStart(11)} (${String(r.sentN).padStart(2)})  ` +
      `recv ${fmt(r.recv).padStart(11)} (${String(r.recvN).padStart(2)})  ` +
      `net ${fmt(r.sent - r.recv).padStart(11)}`,
    )
  }

  // Any counterparty custody paid but never got anything back from is a candidate escrow.
  console.log('\nStuck candidates, custody sent and received nothing back\n')
  for (const r of rows) {
    if (r.recv > 0n || r.sent === 0n) continue
    const isContract = (await provider.getCode(r.addr)) !== '0x'
    if (!isContract) continue
    console.log(`  ${r.token} ${fmt(r.sent)} sat in ${r.addr} across ${r.sentN} transfer(s)`)
    const c = new ethers.Contract(r.token === 'USDC' ? USDC : CNGN, ERC20, provider)
    console.log(`    that contract currently holds ${fmt(await c.balanceOf(r.addr))} ${r.token} in total`)
  }

  console.log('\nOutbound detail, newest first\n')
  for (const t of out.slice(-25).reverse()) {
    console.log(`  ${t.metadata?.blockTimestamp ?? ''} ${tok(t).padEnd(5)} ${fmt(raw(t)).padStart(11)} -> ${t.to} ${t.hash}`)
  }
  console.log('\nInbound detail, newest first\n')
  for (const t of inn.slice(-25).reverse()) {
    console.log(`  ${t.metadata?.blockTimestamp ?? ''} ${tok(t).padEnd(5)} ${fmt(raw(t)).padStart(11)} <- ${t.from} ${t.hash}`)
  }
}

main().catch((e) => { console.error(e.message); process.exit(1) })
