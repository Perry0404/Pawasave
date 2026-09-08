/**
 * Reclaims inputs from HyperFX intent orders that escrowed and never filled.
 *
 * Cancellation needs the exact Order struct and we never persisted it, so each order is
 * decoded back out of its own placeOrder calldata. Dry run by default: it decodes, checks
 * the order is past its deadline, and quotes the cancel. Pass --execute to actually cancel.
 *
 *   node scripts/reclaim-hyperfx-escrow.mjs
 *   node scripts/reclaim-hyperfx-escrow.mjs --execute
 *
 * Needs BASE_WRITE_RPC_URL, HYPERFX_BUNDLER_URL and CUSTODY_PRIVATE_KEY in the environment.
 * Custody needs ETH for gas plus the relayer fee, so check the quote before executing.
 */
import { ethers } from 'ethers'

// The orders that escrowed after the Base gateway moved to the validUntil implementation
// at block 50926074 on 5 Sep 2026. Every one of these expired unfilled.
const STUCK = [
  '0xbdd5bd90e7f10da271946fa496ca0ae1f5d0937a887dbef44932eecaffb9d867',
  '0x43e43cce885e022517bd1d4ba94e5c61b8330d399f7e50d58f7397277c2d935b',
  '0x36b2505d2dbc57665951e2357c1c7e9701b26eaff0faa2135be37b7e0f2e9676',
  '0xf1d6773c569888669bc49db2fb800d7b082d8c78d2342a2345659eadb23d26ed',
  '0x955260c13b79f8e552b2f86db107957a06f0f1c4bb2c83a7bd87d0edb4437229',
  '0x0d1d5bbbdc63ae3d4d0ecfc32d126c4027ea7f55e986a8343729454899bb8ddd',
]

const EXECUTE = process.argv.includes('--execute')
const RPC = process.env.BASE_WRITE_RPC_URL || process.env.BASE_MAINNET_RPC_URL
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const CNGN = '0x46c85152bfe9f96829aa94755d9f915f9b10ef5f'
const NAMES = { [USDC]: 'USDC', [CNGN]: 'cNGN' }

const fmt6 = (v) => (Number(v) / 1e6).toFixed(4)
const asAddress = (bytes32) => ethers.getAddress('0x' + bytes32.slice(-40))

async function main() {
  if (!RPC) throw new Error('set BASE_WRITE_RPC_URL')

  const sdk = await import('@hyperbridge/sdk')
  const viem = await import('viem')
  const { privateKeyToAccount } = await import('viem/accounts')
  const { base } = await import('viem/chains')
  const { EvmChain, IntentGateway, IntentsCoprocessor, createQueryClient, IntentGatewayABI } = sdk

  const provider = new ethers.JsonRpcProvider(RPC, 8453)
  const iface = new ethers.Interface(Array.isArray(IntentGatewayABI) ? IntentGatewayABI : IntentGatewayABI.abi)

  console.log(`mode: ${EXECUTE ? 'EXECUTE, this will send transactions' : 'dry run'}\n`)

  // Decode first. This needs nothing but an RPC, so a decode problem shows up before we
  // touch the coprocessor or ask for a key.
  const orders = []
  for (const hash of STUCK) {
    const tx = await provider.getTransaction(hash)
    if (!tx) { console.log(`${hash}  not found`); continue }
    const parsed = iface.parseTransaction({ data: tx.data, value: tx.value })
    if (!parsed) { console.log(`${hash}  could not parse`); continue }

    const o = parsed.args[0]
    const order = {
      user: o.user,
      source: o.source,
      destination: o.destination,
      deadline: BigInt(o.deadline),
      nonce: BigInt(o.nonce),
      fees: BigInt(o.fees),
      session: o.session,
      predispatch: { assets: o.predispatch.assets.map(mapAsset), call: o.predispatch.call },
      inputs: o.inputs.map(mapAsset),
      output: {
        beneficiary: o.output.beneficiary,
        assets: o.output.assets.map(mapAsset),
        call: o.output.call,
      },
    }
    orders.push({ hash, block: tx.blockNumber, fn: parsed.name, order })
  }

  function mapAsset(a) {
    return { token: a.token, amount: BigInt(a.amount) }
  }

  const head = await provider.getBlockNumber()
  console.log(`Base head block ${head}\n`)

  let totalIn = 0n
  for (const { hash, block, fn, order } of orders) {
    const input = order.inputs[0]
    const token = NAMES[asAddress(input.token).toLowerCase()] ?? asAddress(input.token)
    const out = order.output.assets[0]
    const outToken = NAMES[asAddress(out.token).toLowerCase()] ?? asAddress(out.token)
    const expired = Number(order.deadline) < head
    if (token === 'USDC') totalIn += input.amount

    console.log(`${hash}`)
    console.log(`  ${fn} at block ${block}, deadline block ${order.deadline}, ${expired ? 'EXPIRED' : `still live for ${Number(order.deadline) - head} blocks`}`)
    console.log(`  in  ${fmt6(input.amount)} ${token}   out ${fmt6(out.amount)} ${outToken}`)
    console.log(`  nonce ${order.nonce}  fees ${fmt6(order.fees)}  session ${order.session}`)
  }
  console.log(`\n${orders.length} orders, ${fmt6(totalIn)} USDC of escrowed input to reclaim\n`)

  const live = orders.filter((o) => Number(o.order.deadline) >= head)
  if (live.length) {
    console.log(`${live.length} order(s) have not passed their deadline yet. Cancelling those may be refused, they can still fill.\n`)
  }

  // Quoting and cancelling both need the gateway wired to the coprocessor and bundler.
  if (!process.env.HYPERFX_BUNDLER_URL) {
    console.log('HYPERFX_BUNDLER_URL not set, stopping before the cancel quote.')
    return
  }
  const key = process.env.CUSTODY_PRIVATE_KEY
  if (!key) {
    console.log('CUSTODY_PRIVATE_KEY not set, stopping before the cancel quote.')
    return
  }

  const chain = await EvmChain.create(RPC, process.env.HYPERFX_BUNDLER_URL)
  const coprocessor = await IntentsCoprocessor.connect(
    process.env.HYPERFX_COPROCESSOR_WS || 'wss://nexus.rpc.polytope.technology',
  )
  const queryClient = createQueryClient({
    url: process.env.HYPERFX_INDEXER_URL || 'https://nexus.indexer.polytope.technology',
  })
  const gateway = (await IntentGateway.create(chain, chain, coprocessor)).withQueryClient(queryClient)

  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
  const wallet = viem.createWalletClient({ account, chain: base, transport: viem.http(RPC) })
  console.log(`custody ${account.address}`)
  console.log(`ETH ${ethers.formatEther(await provider.getBalance(account.address))}\n`)

  let quotedFees = 0n
  let quotedNative = 0n
  for (const { hash, order } of orders) {
    try {
      const q = await gateway.quoteCancelOrder(order, { from: 'source' })
      quotedFees += BigInt(q.relayerFee ?? 0n)
      quotedNative += BigInt(q.nativeValue ?? 0n)
      console.log(`${hash.slice(0, 18)}  relayerFee ${fmt6(BigInt(q.relayerFee ?? 0n))}  nativeValue ${ethers.formatEther(BigInt(q.nativeValue ?? 0n))} ETH`)
    } catch (e) {
      console.log(`${hash.slice(0, 18)}  quote failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  console.log(`\ntotal to cancel all: ${fmt6(quotedFees)} relayer fee, ${ethers.formatEther(quotedNative)} ETH`)
  console.log(`reclaimable:         ${fmt6(totalIn)} USDC`)
  if (quotedFees >= totalIn) {
    console.log('\nThe relayer fee is not below what we would recover. Cancelling loses money.')
  }

  if (!EXECUTE) {
    console.log('\nDry run, nothing sent. Re-run with --execute to cancel.')
    return
  }

  for (const { hash, order } of orders) {
    console.log(`\ncancelling ${hash}`)
    try {
      for await (const ev of gateway.cancelOrder(order, queryClient, { from: 'source' })) {
        console.log(`  ${ev.status ?? ev.kind ?? JSON.stringify(ev).slice(0, 200)}`)
      }
      console.log('  done')
    } catch (e) {
      console.log(`  failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  console.log(`\ncustody USDC now ${fmt6(await new ethers.Contract(ethers.getAddress(USDC), ['function balanceOf(address) view returns (uint256)'], provider).balanceOf(account.address))}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
