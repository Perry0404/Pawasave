/**
 * PSS-1 reference token (pMTNN, Base Sepolia): metadata + compliance hold via a NOT policy.
 *
 *   1. ERC-7572 contractURI -> https://pawasave.xyz/pss/metadata/pMTNN.json (Coinbase's shape)
 *   2. extraMetadata keys: isin (as Coinbase) + csd, venue_mic, jurisdiction, regulator,
 *      custodian, dividend_mode, dividend_token, transfer_unit (our proposal to Base)
 *   3. TRANSFER_SENDER_POLICY = INTERSECT(verified, NOT(frozen)): freezing an account is one
 *      allowlist update on `frozen`, no change to the token. Proves it by freezing and
 *      unfreezing a demo holder and checking a transfer before, during and after.
 *
 * Idempotent: every step checks the current value first.
 *   NGX_DEMO_KEY=... node scripts/b20-metadata-and-hold.cjs
 */
const path = require('path')
const fs = require('fs')
const { ethers } = require(path.join(__dirname, '../frontend/node_modules/ethers'))
const DEPLOY = path.join(__dirname, '../deployments/base-sepolia-pss-b20.json')
const d = JSON.parse(fs.readFileSync(DEPLOY, 'utf8'))

const URI = 'https://pawasave.xyz/pss/metadata/pMTNN.json'
const META = {
  isin: 'NGMTNN000002',
  csd: 'CSCS',
  venue_mic: 'XNSA',
  jurisdiction: 'NG',
  regulator: 'SEC Nigeria',
  custodian: 'Licensed Nigerian custodian (testnet: PawaSave demo custodian)',
  dividend_mode: 'cash',
  dividend_token: d.demoCngn,
  transfer_unit: '1',
}
const G = { gasLimit: 500_000 }
const INV = 1n << 63n
const ALLOWLIST = 1, INTERSECT = 3
const id = (s) => ethers.keccak256(ethers.toUtf8Bytes(s))
const SENDER = id('TRANSFER_SENDER_POLICY')

const TOKEN_ABI = [
  'function METADATA_ROLE() view returns (bytes32)', 'function hasRole(bytes32,address) view returns (bool)',
  'function grantRole(bytes32,address)', 'function contractURI() view returns (string)', 'function updateContractURI(string)',
  'function extraMetadata(string) view returns (string)', 'function updateExtraMetadata(string,string)',
  'function policyId(bytes32) view returns (uint64)', 'function updatePolicy(bytes32,uint64)',
  'function transferFrom(address,address,uint256) returns (bool)',
  'error PolicyForbids(bytes32 policyScope, uint64 policyId)',
]
const REG_ABI = [
  'function createPolicy(address,uint8) returns (uint64)', 'function createCompositePolicy(address,uint8,uint64[]) returns (uint64)',
  'function updateAllowlist(uint64,bool,address[])', 'function isAuthorized(uint64,address) view returns (bool)',
  'function invertedPolicyId(uint64) view returns (uint64)', 'function policyExists(uint64) view returns (bool)',
]

async function main() {
  const p = new ethers.JsonRpcProvider('https://sepolia.base.org', 84532, { staticNetwork: true })
  const seed = process.env.NGX_DEMO_KEY
  if (!seed) throw new Error('Set NGX_DEMO_KEY')
  const root = new ethers.Wallet(seed, p)
  const der = (i) => ethers.HDNodeWallet.fromSeed(ethers.keccak256(ethers.toUtf8Bytes(seed + ':' + i))).connect(p)
  const ops = der(1), ada = der(2), bayo = der(3)
  const token = new ethers.Contract(d.token, TOKEN_ABI, root)
  const reg = new ethers.Contract(d.policyRegistry, REG_ABI, root)
  const verified = BigInt(d.verifiedPolicyId)
  const send = async (label, txp) => { const tx = await txp; await tx.wait(); console.log(`  tx ${label}: ${tx.hash}`); return tx.hash }

  if ((await p.getBalance(ops.address)) < ethers.parseEther('0.0001')) {
    await send('fund ops', root.sendTransaction({ to: ops.address, value: ethers.parseEther('0.0003') }))
  }

  // ── 1 + 2. metadata ──
  const M = await token.METADATA_ROLE()
  if (!(await token.hasRole(M, root.address))) await send('grant METADATA_ROLE to issuer admin', token.grantRole(M, root.address, G))
  if ((await token.contractURI()) !== URI) await send('contractURI', token.updateContractURI(URI, G))
  for (const [k, v] of Object.entries(META)) {
    if ((await token.extraMetadata(k)) !== v) await send(`extraMetadata ${k}`, token.updateExtraMetadata(k, v, G))
  }
  console.log('metadata:', await token.contractURI())
  for (const k of Object.keys(META)) console.log(`  ${k} = ${await token.extraMetadata(k)}`)

  // ── 3. compliance hold: INTERSECT(verified, NOT(frozen)) ──
  let frozen = d.frozenPolicyId ? BigInt(d.frozenPolicyId) : 0n
  if (!frozen) {
    frozen = await reg.createPolicy.staticCall(ops.address, ALLOWLIST)
    await send('create frozen allowlist (admin: ops)', reg.createPolicy(ops.address, ALLOWLIST, G))
    d.frozenPolicyId = frozen.toString()
  }
  let hold = d.senderHoldPolicyId ? BigInt(d.senderHoldPolicyId) : 0n
  if (!hold) {
    const children = [verified, await reg.invertedPolicyId(frozen)]
    hold = await reg.createCompositePolicy.staticCall(ops.address, INTERSECT, children)
    await send('create INTERSECT(verified, NOT(frozen))', reg.createCompositePolicy(ops.address, INTERSECT, children, G))
    d.senderHoldPolicyId = hold.toString()
  }
  fs.writeFileSync(DEPLOY, JSON.stringify(d, null, 2) + '\n')
  if ((await token.policyId(SENDER)) !== hold) await send('TRANSFER_SENDER_POLICY -> hold composite', token.updatePolicy(SENDER, hold, G))
  console.log(`policies: frozen=${frozen} hold=${hold} sender=${await token.policyId(SENDER)}`)

  // ── prove it: a router transfer from ada, before / during / after a freeze ──
  const probe = async () => {
    try { await p.call({ from: d.router, to: d.token, data: token.interface.encodeFunctionData('transferFrom', [ada.address, bayo.address, 0n]) }); return 'succeeds' }
    catch (e) { const raw = e?.data || e?.info?.error?.data; try { const er = token.interface.parseError(raw); return `${er.name}(${er.args.join(',')})` } catch { return 'reverts' } }
  }
  const regOps = reg.connect(ops)
  console.log(`  before freeze: authorized=${await reg.isAuthorized(hold, ada.address)} transfer=${await probe()}`)
  if (!(await reg.isAuthorized(frozen, ada.address))) await send('freeze ada', regOps.updateAllowlist(frozen, true, [ada.address], G))
  console.log(`  frozen:        authorized=${await reg.isAuthorized(hold, ada.address)} transfer=${await probe()}`)
  await send('unfreeze ada', regOps.updateAllowlist(frozen, false, [ada.address], G))
  console.log(`  after:         authorized=${await reg.isAuthorized(hold, ada.address)} transfer=${await probe()}`)
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1) })
