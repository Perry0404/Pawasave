import { expect } from "chai"
import { ethers } from "hardhat"
import { keccak256, toUtf8Bytes, Signature } from "ethers"
import { time } from "@nomicfoundation/hardhat-network-helpers"
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import { buildTree, proRata } from "../scripts/lib/dividend-merkle"

// PSS-1 on B20: mint gate, whole-share router, redemption vault and Merkle dividends, against
// local doubles of the B20 Asset token and Policy Registry (contracts/b20/mocks).
describe("PSS-1 on B20 (NGX pilot)", function () {
  let registry: any, token: any, gate: any, router: any, vault: any, cngn: any, div: any
  let admin: SignerWithAddress, custodian: SignerWithAddress, ops: SignerWithAddress, trustee: SignerWithAddress
  let ada: SignerWithAddress, bayo: SignerWithAddress, stranger: SignerWithAddress
  let verifiedId: bigint

  const UNIT = 1_000_000n
  const ref = (s: string) => keccak256(toUtf8Bytes(s))
  const naira = (n: number) => BigInt(n) * 1_000_000n

  async function attest(signer: SignerWithAddress, to: string, shares: bigint, settlementRef: string, deadline?: bigint) {
    const dl = deadline ?? BigInt((await time.latest()) + 3600)
    const domain = { name: "PawaMintGate", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await gate.getAddress() }
    const types = { MintAttestation: [
      { name: "to", type: "address" }, { name: "shares", type: "uint256" },
      { name: "settlementRef", type: "bytes32" }, { name: "deadline", type: "uint256" },
    ] }
    return { dl, sig: await signer.signTypedData(domain, types, { to, shares, settlementRef, deadline: dl }) }
  }

  // The custodian's pool rises (statement posted), then the custodian signs, then the gate mints.
  async function settleAndMint(to: SignerWithAddress, shares: bigint, settlementRef: string) {
    await gate.connect(ops).reportReserve((await gate.sharesRequired()) + shares, ref("stmt-" + settlementRef))
    const { dl, sig } = await attest(custodian, to.address, shares, ref(settlementRef))
    return gate.connect(ops).mintWithAttestation(to.address, shares, ref(settlementRef), dl, sig)
  }

  async function permitSig(owner: SignerWithAddress, spender: string, value: bigint) {
    const deadline = BigInt((await time.latest()) + 3600)
    const domain = { name: await token.name(), version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await token.getAddress() }
    const types = { Permit: [
      { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] }
    const sig = Signature.from(await owner.signTypedData(domain, types, { owner: owner.address, spender, value, nonce: await token.nonces(owner.address), deadline }))
    return { deadline, v: sig.v, r: sig.r, s: sig.s }
  }

  beforeEach(async () => {
    ;[admin, custodian, ops, trustee, ada, bayo, stranger] = await ethers.getSigners()
    registry = await (await ethers.getContractFactory("MockPolicyRegistry")).deploy()
    token = await (await ethers.getContractFactory("MockB20Asset")).deploy("PawaSave MTN Nigeria", "pMTNN", admin.address, await registry.getAddress())
    gate = await (await ethers.getContractFactory("PawaMintGate")).deploy(await token.getAddress(), admin.address, custodian.address, 10_000n, 50_000n)
    router = await (await ethers.getContractFactory("WholeShareRouter")).deploy(await token.getAddress())
    vault = await (await ethers.getContractFactory("PawaRedemptionVault")).deploy(await token.getAddress(), admin.address)

    // Policies: the verified register (KYC'd wallets and the vault) gates minting, sending and
    // receiving; only the router and the vault may initiate transfers.
    const mk = async (accounts: string[]) => {
      const rc = await (await registry.createPolicyWithAccounts(ops.address, 1, accounts)).wait()
      return registry.interface.parseLog(rc.logs[0]).args.policyId as bigint
    }
    verifiedId = await mk([ada.address, bayo.address, await vault.getAddress()])
    const executorId = await mk([await router.getAddress(), await vault.getAddress()])
    for (const scope of ["MINT_RECEIVER_POLICY", "TRANSFER_SENDER_POLICY", "TRANSFER_RECEIVER_POLICY"]) {
      await token.connect(admin).updatePolicy(await token[scope](), verifiedId)
    }
    await token.connect(admin).updatePolicy(await token.TRANSFER_EXECUTOR_POLICY(), executorId)

    await token.connect(admin).grantRole(await token.MINT_ROLE(), await gate.getAddress())
    await token.connect(admin).grantRole(await token.BURN_ROLE(), await vault.getAddress())
    await token.connect(admin).grantRole(await token.OPERATOR_ROLE(), admin.address)
    await gate.connect(admin).grantRole(await gate.MINTER_ROLE(), ops.address)
    await gate.connect(admin).grantRole(await gate.RECONCILER_ROLE(), ops.address)
    await vault.connect(admin).grantRole(await vault.SETTLER_ROLE(), ops.address)
  })

  describe("mint gate: whole shares, only against the custodian", () => {
    it("mints whole shares against a custodian attestation and writes the reference as the memo", async () => {
      await expect(settleAndMint(ada, 100n, "NGX-T1"))
        .to.emit(gate, "MintedAgainstSettlement").withArgs(ada.address, 100n, ref("NGX-T1"))
        .and.to.emit(token, "Memo").withArgs(await gate.getAddress(), ref("NGX-T1"))
      expect(await token.balanceOf(ada.address)).to.equal(100n * UNIT)
    })

    it("refuses a signature from anyone but the custodian, a replay, tampering and expiry", async () => {
      await gate.connect(ops).reportReserve(10_000n, ref("stmt"))
      const bad = await attest(ops, ada.address, 100n, ref("T1"))
      await expect(gate.connect(ops).mintWithAttestation(ada.address, 100n, ref("T1"), bad.dl, bad.sig)).to.be.revertedWith("not attested by custodian")
      const good = await attest(custodian, ada.address, 100n, ref("T1"))
      await expect(gate.connect(ops).mintWithAttestation(ada.address, 1000n, ref("T1"), good.dl, good.sig)).to.be.revertedWith("not attested by custodian")
      await gate.connect(ops).mintWithAttestation(ada.address, 100n, ref("T1"), good.dl, good.sig)
      await expect(gate.connect(ops).mintWithAttestation(ada.address, 100n, ref("T1"), good.dl, good.sig)).to.be.revertedWith("settlement already minted")
      const old = await attest(custodian, ada.address, 5n, ref("T2"), BigInt(await time.latest()) - 1n)
      await expect(gate.connect(ops).mintWithAttestation(ada.address, 5n, ref("T2"), old.dl, old.sig)).to.be.revertedWith("attestation expired")
    })

    it("the token refuses to mint to a wallet that is not on the verified register", async () => {
      await expect(settleAndMint(stranger, 10n, "T3")).to.be.revertedWith("PolicyForbids: mint receiver")
    })

    it("never mints beyond the custodian's last statement", async () => {
      await gate.connect(ops).reportReserve(50n, ref("stmt"))
      const { dl, sig } = await attest(custodian, ada.address, 60n, ref("T4"))
      await expect(gate.connect(ops).mintWithAttestation(ada.address, 60n, ref("T4"), dl, sig)).to.be.revertedWith("reserve does not cover")
    })

    it("a short statement halts minting until a covering one is posted", async () => {
      await settleAndMint(ada, 100n, "T5")
      await expect(gate.connect(ops).reportReserve(90n, ref("short"))).to.emit(gate, "ReserveReported").withArgs(90n, 100n, ref("short"), true)
      expect(await gate.mintHalted()).to.equal(true)
      const { dl, sig } = await attest(custodian, ada.address, 1n, ref("T6"))
      await expect(gate.connect(ops).mintWithAttestation(ada.address, 1n, ref("T6"), dl, sig)).to.be.revertedWith("minting halted")
      await expect(gate.connect(ops).setMintHalt(false, "too early")).to.be.revertedWith("reserve still short")
      await gate.connect(ops).reportReserve(100n, ref("fixed"))
      await gate.connect(ops).setMintHalt(false, "statement corrected")
      await settleAndMint(ada, 1n, "T6")
    })

    it("after a 1-for-1 bonus the gate counts shares, not tokens, and anyone can trip the halt", async () => {
      await settleAndMint(ada, 100n, "T7")
      await token.connect(admin).updateMultiplier(2n * 10n ** 18n)
      expect(await gate.sharesRequired()).to.equal(200n)
      const { dl, sig } = await attest(custodian, ada.address, 1n, ref("T8"))
      await expect(gate.connect(ops).mintWithAttestation(ada.address, 1n, ref("T8"), dl, sig)).to.be.revertedWith("reserve does not cover")
      await gate.connect(stranger).checkReserve()
      expect(await gate.mintHalted()).to.equal(true)
    })

    it("enforces per-mint and daily caps", async () => {
      await gate.connect(admin).setMintCaps(100n, 150n)
      await expect(settleAndMint(ada, 101n, "T9")).to.be.revertedWith("over per-mint cap")
      await settleAndMint(ada, 100n, "T10")
      await expect(settleAndMint(ada, 60n, "T11")).to.be.revertedWith("over daily cap")
    })
  })

  describe("whole-share router", () => {
    beforeEach(async () => { await settleAndMint(ada, 10n, "R0") })

    it("a holder cannot move tokens directly: only the router and the vault may initiate transfers", async () => {
      await expect(token.connect(ada).transfer(bayo.address, UNIT)).to.be.revertedWith("PolicyForbids: executor")
      await token.connect(ada).approve(bayo.address, UNIT)
      await expect(token.connect(bayo).transferFrom(ada.address, bayo.address, UNIT)).to.be.revertedWith("PolicyForbids: executor")
    })

    it("moves whole shares between verified holders", async () => {
      await token.connect(ada).approve(await router.getAddress(), 3n * UNIT)
      await expect(router.connect(ada).transfer(bayo.address, 3n, ref("gift")))
        .to.emit(router, "WholeShareTransfer").withArgs(ada.address, bayo.address, 3n, ref("gift"))
      expect(await token.balanceOf(bayo.address)).to.equal(3n * UNIT)
      expect(await token.balanceOf(ada.address)).to.equal(7n * UNIT)
    })

    it("approves and sends in one step with a permit", async () => {
      const p = await permitSig(ada, await router.getAddress(), 2n * UNIT)
      await router.connect(ada).transferWithPermit(bayo.address, 2n, ref("gift"), p.deadline, p.v, p.r, p.s)
      expect(await token.balanceOf(bayo.address)).to.equal(2n * UNIT)
    })

    it("still refuses an unverified receiver", async () => {
      await token.connect(ada).approve(await router.getAddress(), UNIT)
      await expect(router.connect(ada).transfer(stranger.address, 1n, ref("x"))).to.be.revertedWith("PolicyForbids: receiver")
    })

    it("an approval to the router cannot be used by anyone else", async () => {
      await token.connect(ada).approve(await router.getAddress(), 10n * UNIT)
      // Bayo calling the router can only ever move Bayo's own tokens (he has none).
      await expect(router.connect(bayo).transfer(bayo.address, 1n, ref("x"))).to.be.reverted
      expect(await token.balanceOf(ada.address)).to.equal(10n * UNIT)
    })

    it("no fraction of a share can exist: every route moves whole units", async () => {
      await token.connect(ada).approve(await router.getAddress(), 10n * UNIT)
      await router.connect(ada).transfer(bayo.address, 3n, ref("a"))
      await token.connect(bayo).approve(await vault.getAddress(), UNIT)
      await vault.connect(bayo).requestRedemption(1n, 0)
      await vault.connect(ops).completeRedemption(0, ref("sale"))
      for (const a of [ada.address, bayo.address, await vault.getAddress()]) expect((await token.balanceOf(a)) % UNIT).to.equal(0n)
      expect((await token.totalSupply()) % UNIT).to.equal(0n)
    })
  })

  describe("redemption vault: lock, then burn", () => {
    beforeEach(async () => { await settleAndMint(bayo, 40n, "V0") })

    it("locks on request and burns only after settlement", async () => {
      await token.connect(bayo).approve(await vault.getAddress(), 30n * UNIT)
      await expect(vault.connect(bayo).requestRedemption(30n, 0)).to.emit(vault, "RedemptionRequested").withArgs(0n, bayo.address, 30n, 0)
      expect(await token.balanceOf(await vault.getAddress())).to.equal(30n * UNIT)
      expect(await token.totalSupply()).to.equal(40n * UNIT) // shares not sold yet
      await vault.connect(ops).completeRedemption(0, ref("NGX-SALE-1"))
      expect(await token.totalSupply()).to.equal(10n * UNIT)
      expect(await vault.lockedShares()).to.equal(0n)
    })

    it("returns tokens in full if settlement fails, and only the settler can close", async () => {
      const p = await permitSig(bayo, await vault.getAddress(), 10n * UNIT)
      await vault.connect(bayo).requestRedemptionWithPermit(10n, 1, p.deadline, p.v, p.r, p.s)
      await expect(vault.connect(bayo).completeRedemption(0, ref("x"))).to.be.reverted
      await vault.connect(ops).cancelRedemption(0, "CHN mismatch at CSCS")
      expect(await token.balanceOf(bayo.address)).to.equal(40n * UNIT)
      await expect(vault.connect(ops).cancelRedemption(0, "again")).to.be.revertedWith("not pending")
    })

    it("a holder removed from the register cannot redeem", async () => {
      await registry.connect(ops).updateAllowlist(verifiedId, false, [bayo.address])
      await token.connect(bayo).approve(await vault.getAddress(), UNIT)
      await expect(vault.connect(bayo).requestRedemption(1n, 0)).to.be.revertedWith("PolicyForbids: sender")
    })
  })

  describe("dividends against a record block", () => {
    let tree: ReturnType<typeof buildTree>, ents: { account: string; amount: bigint }[], recordBlock: number

    beforeEach(async () => {
      cngn = await (await ethers.getContractFactory("MockERC20")).deploy("cNGN", "cNGN", 6)
      div = await (await ethers.getContractFactory("PawaMerkleDividend")).deploy(await token.getAddress(), await cngn.getAddress(), await registry.getAddress(), verifiedId, admin.address)
      await div.connect(admin).grantRole(await div.ISSUER_ROLE(), ops.address)
      await div.connect(admin).grantRole(await div.TRUSTEE_ROLE(), trustee.address)
      await settleAndMint(ada, 60n, "D1")
      await settleAndMint(bayo, 40n, "D2")
      recordBlock = await ethers.provider.getBlockNumber()
      const holdings = []
      for (const h of [ada, bayo]) holdings.push({ account: h.address, units: await token.balanceOf(h.address, { blockTag: recordBlock }) })
      ents = proRata(naira(1000), holdings)
      tree = buildTree(ents)
    })

    const declare = async (fund = true) => {
      if (fund) await cngn.connect(admin).mint(await div.getAddress(), naira(1000))
      await div.connect(ops).declare(tree.root, naira(1000), recordBlock, "MTNN-FY2026-FINAL")
      return (await div.dividendCount()) - 1n
    }

    it("pays each holder their pro-rata amount from the published list", async () => {
      const id = await declare()
      await div.connect(trustee).approve(id)
      await div.connect(stranger).pay(id, ada.address, ents[0].amount, tree.proof(0))
      await div.connect(stranger).pay(id, bayo.address, ents[1].amount, tree.proof(1))
      expect(await cngn.balanceOf(ada.address)).to.equal(naira(600))
      expect(await cngn.balanceOf(bayo.address)).to.equal(naira(400))
    })

    it("refuses an amount not in the list, a second payment, and anyone not in the list", async () => {
      const id = await declare()
      await div.connect(trustee).approve(id)
      await expect(div.pay(id, ada.address, naira(700), tree.proof(0))).to.be.revertedWith("not in record")
      await expect(div.pay(id, stranger.address, ents[0].amount, tree.proof(0))).to.be.revertedWith("not in record")
      await div.pay(id, ada.address, ents[0].amount, tree.proof(0))
      await expect(div.pay(id, ada.address, ents[0].amount, tree.proof(0))).to.be.revertedWith("already paid")
    })

    it("needs the trustee, and the trustee cannot approve before the money is in", async () => {
      const id = await declare(false)
      await expect(div.pay(id, ada.address, ents[0].amount, tree.proof(0))).to.be.revertedWith("not payable")
      await expect(div.connect(trustee).approve(id)).to.be.revertedWith("not funded")
      await expect(div.connect(ops).approve(id)).to.be.reverted
    })

    it("a holder removed from the register is not paid until resolved", async () => {
      const id = await declare()
      await div.connect(trustee).approve(id)
      await registry.connect(ops).updateAllowlist(verifiedId, false, [bayo.address])
      await expect(div.pay(id, bayo.address, ents[1].amount, tree.proof(1))).to.be.revertedWith("holder not verified")
      await registry.connect(ops).updateAllowlist(verifiedId, true, [bayo.address])
      await div.pay(id, bayo.address, ents[1].amount, tree.proof(1))
    })

    it("payments can never exceed the declared total, even with a bad list", async () => {
      const inflated = buildTree([{ account: ada.address, amount: naira(900) }, { account: bayo.address, amount: naira(900) }])
      await cngn.connect(admin).mint(await div.getAddress(), naira(1000))
      await div.connect(ops).declare(inflated.root, naira(1000), recordBlock, "BAD")
      await div.connect(trustee).approve(0)
      await div.pay(0, ada.address, naira(900), inflated.proof(0))
      await expect(div.pay(0, bayo.address, naira(900), inflated.proof(1))).to.be.revertedWith("exceeds declared total")
    })

    it("the trustee recovers unclaimed money after twelve months", async () => {
      const id = await declare()
      await div.connect(trustee).approve(id)
      await div.pay(id, ada.address, ents[0].amount, tree.proof(0))
      await expect(div.connect(trustee).close(id, trustee.address)).to.be.revertedWith("too early")
      await time.increase(366 * 24 * 3600)
      await expect(div.connect(trustee).close(id, trustee.address)).to.emit(div, "DividendClosed").withArgs(id, trustee.address, naira(400))
    })
  })
})
