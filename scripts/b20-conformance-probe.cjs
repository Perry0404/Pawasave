/**
 * B20 conformance probe: checks the live B20 precompiles on Base Sepolia against the revert
 * conditions documented in base/base-std (src/interfaces/IB20.sol, IPolicyRegistry.sol, IB20Factory.sol).
 * Read-only: every case is an eth_call (staticCall); nothing is written.
 *
 *   NGX_DEMO_KEY=... node scripts/b20-conformance-probe.cjs
 */
const path = require('path')
const { ethers } = require(path.join(__dirname, '../frontend/node_modules/ethers'))
const d = require('../deployments/base-sepolia-pss-b20.json')

const ERRORS = [
  'error AccessControlBadConfirmation()', 'error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)',
  'error AccountNotSeizable(address account)', 'error BatchSizeTooLarge(uint256 maxBatchSize)', 'error ChildPoliciesOutsideOfRange()',
  'error ContractPaused(uint8 feature)', 'error EmptyFeatureSet()', 'error ExpiredSignature(uint256 deadline)', 'error IncompatiblePolicyType()',
  'error InsufficientAllowance(address spender, uint256 allowance, uint256 needed)', 'error InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error InvalidAmount()', 'error InvalidApprover(address approver)', 'error InvalidChildPolicy(uint64 childPolicyId)', 'error InvalidReceiver(address receiver)',
  'error InvalidSender(address sender)', 'error InvalidSigner(address signer, address owner)', 'error InvalidSpender(address spender)',
  'error InvalidSupplyCap(uint256 currentSupply, uint256 proposedCap)', 'error LastAdminCannotRenounce()', 'error NonPayable()', 'error NotSoleAdmin()',
  'error PolicyForbids(bytes32 policyScope, uint64 policyId)', 'error PolicyNotFound(uint64 policyId)', 'error SupplyCapExceeded(uint256 cap, uint256 attempted)',
  'error Unauthorized()', 'error UnsupportedPolicyType(bytes32 policyScope)', 'error ZeroAddress()', 'error InvalidDecimals(uint8 decimals)',
  'error TokenAlreadyExists(address token)', 'error InvalidMultiplier()',
]
const TOKEN = new ethers.Interface([
  ...ERRORS,
  'function transfer(address,uint256) returns (bool)', 'function transferFrom(address,address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)', 'function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  'function updatePolicy(bytes32,uint64)', 'function updateSupplyCap(uint256)', 'function supplyCap() view returns (uint256)',
  'function pause(uint8[])', 'function renounceRole(bytes32,address)', 'function seizeWithMemo(address,address,uint256,bytes32)',
  'function mintWithMemo(address,uint256,bytes32)', 'function updateMultiplier(uint256)', 'function nonces(address) view returns (uint256)',
  'function name() view returns (string)', 'function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)', 'function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])',
])
const REG = new ethers.Interface([
  ...ERRORS,
  'function createPolicy(address,uint8) returns (uint64)', 'function createPolicyWithAccounts(address,uint8,address[]) returns (uint64)',
  'function updateAllowlist(uint64,bool,address[])', 'function createCompositePolicy(address,uint8,uint64[]) returns (uint64)',
  'function isAuthorized(uint64,address) view returns (bool)', 'function policyExists(uint64) view returns (bool)',
  'function invertedPolicyId(uint64) view returns (uint64)', 'function policyAdmin(uint64) view returns (address)',
])
const FACTORY = new ethers.Interface([
  ...ERRORS,
  'function createB20(uint8,bytes32,bytes,bytes[]) payable returns (address)', 'function isB20(address) view returns (bool)',
])

const id = (s) => ethers.keccak256(ethers.toUtf8Bytes(s))
const results = []

async function main() {
  const p = new ethers.JsonRpcProvider('https://sepolia.base.org', 84532, { staticNetwork: true })
  const seed = process.env.NGX_DEMO_KEY
  if (!seed) throw new Error('Set NGX_DEMO_KEY')
  const root = new ethers.Wallet(seed, p)
  const der = (i) => ethers.HDNodeWallet.fromSeed(ethers.keccak256(ethers.toUtf8Bytes(seed + ':' + i))).connect(p)
  const ada = der(2), bayo = der(3)
  const T = d.token, R = d.policyRegistry, F = '0xB20f000000000000000000000000000000000000'

  async function call(from, to, iface, fn, args, value) {
    const data = iface.encodeFunctionData(fn, args)
    try {
      const out = await p.call({ from, to, data, value })
      return { ok: true, out: iface.decodeFunctionResult(fn, out) }
    } catch (e) {
      const raw = e?.data || e?.info?.error?.data
      let name = 'revert (no data)'
      if (raw && raw !== '0x') { try { const er = iface.parseError(raw); name = er ? `${er.name}(${er.args.map(String).join(',')})` : raw.slice(0, 10) } catch { name = raw.slice(0, 10) } }
      return { ok: false, name }
    }
  }
  async function check(label, doc, expect, run) {
    const r = await run()
    const got = r.ok ? 'succeeds' : r.name
    const pass = expect === 'succeeds' ? r.ok : !r.ok && r.name.startsWith(expect)
    results.push({ label, doc, expect, got, pass })
    console.log(`${pass ? 'OK  ' : 'DIFF'} ${label}\n       documented: ${expect} · live: ${got}`)
  }

  const verified = BigInt(d.verifiedPolicyId)
  const supply = (await call(root.address, T, TOKEN, 'totalSupply', [])).out[0]

  // ── transfers
  await check('transfer to the zero address', 'IB20.transfer: InvalidReceiver when to == address(0)', 'InvalidReceiver', () => call(ada.address, T, TOKEN, 'transfer', [ethers.ZeroAddress, 1n]))
  await check('transfer to the token itself', 'IB20.transfer: InvalidReceiver when to == address(this) (Denim)', 'InvalidReceiver', () => call(ada.address, T, TOKEN, 'transfer', [T, 1n]))
  await check('transfer by a holder not on the executor allowlist', 'IB20.transfer: PolicyForbids(TRANSFER_EXECUTOR_POLICY) (Denim)', 'PolicyForbids', () => call(ada.address, T, TOKEN, 'transfer', [bayo.address, 1n]))
  // Denim order for transferFrom: pause, receiver, zero sender, ALLOWANCE, executor, sender, receiver, balance.
  // So a self-transferFrom with no self-allowance fails on allowance first; the executor check is
  // only reached once the holder has approved themselves (ada holds a 1-unit self-allowance on Sepolia).
  await check('self-transferFrom with no self-allowance', 'Denim transferFrom order: allowance is checked before the executor policy', 'InsufficientAllowance', () => call(bayo.address, T, TOKEN, 'transferFrom', [bayo.address, ada.address, 1n]))
  await check('self-transferFrom with a self-allowance, holder not on the executor allowlist', 'Denim: TRANSFER_EXECUTOR_POLICY applies to every transfer path, incl. msg.sender == from', 'PolicyForbids', () => call(ada.address, T, TOKEN, 'transferFrom', [ada.address, bayo.address, 1n]))
  await check('transferFrom by a third party with no allowance', 'IB20.transferFrom: InsufficientAllowance', 'InsufficientAllowance', () => call(root.address, T, TOKEN, 'transferFrom', [ada.address, bayo.address, 1n]))
  await check('transfer with ETH attached', 'IB20: NonPayable on non-payable selectors', 'NonPayable', () => call(ada.address, T, TOKEN, 'transfer', [bayo.address, 1n], 1n))
  await check('zero-amount transfer by the router (allowlisted executor)', 'ERC-20: zero-value transfers are allowed', 'succeeds', () => call(d.router, T, TOKEN, 'transferFrom', [ada.address, bayo.address, 0n]))

  // ── approvals and permit
  await check('approve the zero address', 'IB20.approve: InvalidSpender', 'InvalidSpender', () => call(ada.address, T, TOKEN, 'approve', [ethers.ZeroAddress, 1n]))
  const name = (await call(root.address, T, TOKEN, 'name', [])).out[0]
  const nonce = (await call(root.address, T, TOKEN, 'nonces', [ada.address])).out[0]
  const sign = async (signer, deadline) => ethers.Signature.from(await signer.signTypedData(
    { name, version: '1', chainId: 84532, verifyingContract: T },
    { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    { owner: ada.address, spender: d.router, value: 1n, nonce, deadline }))
  const past = BigInt(Math.floor(Date.now() / 1000) - 3600), future = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const s1 = await sign(ada, past)
  await check('permit past its deadline', 'IB20.permit: ExpiredSignature', 'ExpiredSignature', () => call(root.address, T, TOKEN, 'permit', [ada.address, d.router, 1n, past, s1.v, s1.r, s1.s]))
  const s2 = await sign(bayo, future)
  await check('permit signed by the wrong key', 'IB20.permit: InvalidSigner', 'InvalidSigner', () => call(root.address, T, TOKEN, 'permit', [ada.address, d.router, 1n, future, s2.v, s2.r, s2.s]))
  const s3 = await sign(ada, future)
  await check('valid permit (version "1" EIP-712 domain)', 'IB20.permit: EIP-2612', 'succeeds', () => call(root.address, T, TOKEN, 'permit', [ada.address, d.router, 1n, future, s3.v, s3.r, s3.s]))

  // ── admin surface
  await check('updatePolicy with an unknown scope', 'IB20.updatePolicy: UnsupportedPolicyType', 'UnsupportedPolicyType', () => call(root.address, T, TOKEN, 'updatePolicy', [id('NOT_A_SCOPE'), 0n]))
  await check('updatePolicy with a policy that does not exist', 'IB20.updatePolicy: PolicyNotFound', 'PolicyNotFound', () => call(root.address, T, TOKEN, 'updatePolicy', [id('TRANSFER_SENDER_POLICY'), verified + 1_000_000n]))
  await check('supply cap below total supply', 'IB20.updateSupplyCap: InvalidSupplyCap', 'InvalidSupplyCap', () => call(root.address, T, TOKEN, 'updateSupplyCap', [supply > 0n ? supply - 1n : 0n]))
  await check('supply cap above uint128 max', 'IB20.updateSupplyCap: InvalidSupplyCap', 'InvalidSupplyCap', () => call(root.address, T, TOKEN, 'updateSupplyCap', [2n ** 128n]))
  await check('pause by an account without PAUSE_ROLE', 'IB20.pause: AccessControlUnauthorizedAccount', 'AccessControlUnauthorizedAccount', () => call(root.address, T, TOKEN, 'pause', [[0]]))
  await check('sole admin renouncing DEFAULT_ADMIN_ROLE', 'IB20.renounceRole: LastAdminCannotRenounce', 'LastAdminCannotRenounce', () => call(root.address, T, TOKEN, 'renounceRole', [ethers.ZeroHash, root.address]))
  await check('seize without SEIZE_ROLE', 'IB20.seizeWithMemo: AccessControlUnauthorizedAccount', 'AccessControlUnauthorizedAccount', () => call(root.address, T, TOKEN, 'seizeWithMemo', [ada.address, root.address, 1n, ethers.ZeroHash]))
  await check('mint without MINT_ROLE', 'IB20.mint: AccessControlUnauthorizedAccount', 'AccessControlUnauthorizedAccount', () => call(root.address, T, TOKEN, 'mintWithMemo', [ada.address, 1n, ethers.ZeroHash]))
  await check('mint by the gate to the token itself', 'IB20.mint: InvalidReceiver when to == address(this) (Denim)', 'InvalidReceiver', () => call(d.mintGate, T, TOKEN, 'mintWithMemo', [T, 1n, ethers.ZeroHash]))
  await check('mint by the gate to an unverified wallet', 'IB20.mint: PolicyForbids(MINT_RECEIVER_POLICY)', 'PolicyForbids', () => call(d.mintGate, T, TOKEN, 'mintWithMemo', [ethers.Wallet.createRandom().address, 1n, ethers.ZeroHash]))
  await check('updateMultiplier without OPERATOR_ROLE', 'IB20Asset: OPERATOR_ROLE required', 'AccessControlUnauthorizedAccount', () => call(root.address, T, TOKEN, 'updateMultiplier', [2n * 10n ** 18n]))

  // ── policy registry
  await check('createPolicy with a zero admin', 'IPolicyRegistry: ZeroAddress', 'ZeroAddress', () => call(root.address, R, REG, 'createPolicy', [ethers.ZeroAddress, 1]))
  const many = Array.from({ length: 65 }, () => ethers.Wallet.createRandom().address)
  await check('allowlist batch of 65 accounts', 'IPolicyRegistry: BatchSizeTooLarge(64)', 'BatchSizeTooLarge', () => call(root.address, R, REG, 'createPolicyWithAccounts', [root.address, 1, many]))
  await check('updateAllowlist by a non-admin', 'IPolicyRegistry: Unauthorized', 'Unauthorized', () => call(root.address, R, REG, 'updateAllowlist', [verified, true, [root.address]]))
  await check('composite with one child', 'IPolicyRegistry: ChildPoliciesOutsideOfRange', 'ChildPoliciesOutsideOfRange', () => call(root.address, R, REG, 'createCompositePolicy', [root.address, 2, [verified]]))
  await check('composite with a sentinel child (0)', 'IPolicyRegistry: InvalidChildPolicy', 'InvalidChildPolicy', () => call(root.address, R, REG, 'createCompositePolicy', [root.address, 2, [verified, 0n]]))
  await check('isAuthorized on a malformed ID never reverts', 'IPolicyRegistry.isAuthorized: never reverts, false for malformed', 'succeeds', () => call(root.address, R, REG, 'isAuthorized', [2n ** 64n - 1n, ada.address]))
  await check('allowlist policy with the wrong update function (blocklist op)', 'IPolicyRegistry: IncompatiblePolicyType', 'Unauthorized', () => call(root.address, R, REG, 'updateAllowlist', [verified, false, [ada.address]]))

  // ── NOT / inverted policies (Denim: bit 63 of a policy ID is an invert flag)
  const INV = 1n << 63n
  const value = async (fn, args) => { const r = await call(root.address, R, REG, fn, args); return r.ok ? r.out[0] : r.name }
  const expectValue = async (label, doc, want, fn, args) => {
    const got = await value(fn, args)
    const pass = typeof got !== 'string' && got === want
    results.push({ label, doc, expect: String(want), got: String(got), pass })
    console.log(`${pass ? 'OK  ' : 'DIFF'} ${label}\n       documented: ${want} · live: ${got}`)
  }
  await expectValue('invertedPolicyId sets bit 63', 'invertedPolicyId toggles INVERTED_POLICY_BIT', verified | INV, 'invertedPolicyId', [verified])
  await expectValue('invertedPolicyId is involutive', 'invertedPolicyId(invertedPolicyId(x)) == x', verified, 'invertedPolicyId', [verified | INV])
  await expectValue('inverted allowlist: a member is NOT authorized', 'isAuthorized negates the base result', false, 'isAuthorized', [verified | INV, ada.address])
  await expectValue('inverted allowlist: a non-member IS authorized', 'isAuthorized negates the base result', true, 'isAuthorized', [verified | INV, ethers.Wallet.createRandom().address])
  await expectValue('inverted ID whose base does not exist is never allow-all', 'unknown/malformed base under the flag returns false', false, 'isAuthorized', [(verified + 1_000_000n) | INV, ada.address])
  await expectValue('policyExists strips the flag', 'getters read the base record', true, 'policyExists', [verified | INV])
  await check('composite with an inverted allowlist child', 'createCompositePolicy accepts inverted ALLOWLIST/BLOCKLIST children', 'succeeds', () => call(root.address, R, REG, 'createCompositePolicy', [root.address, 2, [verified, BigInt(d.executorPolicyId) | INV]]))
  await check('composite with an inverted sentinel child', 'sentinels revert InvalidChildPolicy with or without the flag', 'InvalidChildPolicy', () => call(root.address, R, REG, 'createCompositePolicy', [root.address, 2, [verified, INV]]))

  // ── factory
  const params = (dec) => ethers.AbiCoder.defaultAbiCoder().encode(['tuple(uint8,string,string,address,uint8)'], [[1, 'Probe', 'PRB', root.address, dec]])
  await check('createB20 Asset with 5 decimals', 'IB20Factory: InvalidDecimals outside [6,18]', 'InvalidDecimals', () => call(root.address, F, FACTORY, 'createB20', [0, id('probe-5'), params(5), []]))
  await check('createB20 Asset with 19 decimals', 'IB20Factory: InvalidDecimals outside [6,18]', 'InvalidDecimals', () => call(root.address, F, FACTORY, 'createB20', [0, id('probe-19'), params(19), []]))

  const diffs = results.filter((r) => !r.pass)
  console.log(`\n${results.length} cases · ${results.length - diffs.length} as documented · ${diffs.length} different`)
  for (const r of diffs) console.log(` - ${r.label}: documented ${r.expect}, live ${r.got}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
