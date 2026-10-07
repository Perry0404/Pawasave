import { expect } from "chai"
import { ethers } from "hardhat"
import { keccak256, toUtf8Bytes } from "ethers"
import { time } from "@nomicfoundation/hardhat-network-helpers"
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"

// PSS-1 dividends: cNGN paid pro-rata against the token's record-date snapshot.
describe("PawaDividendDistributor (NGX pilot)", function () {
  let token: any, cngn: any, dist: any
  let admin: SignerWithAddress, custodian: SignerWithAddress, ops: SignerWithAddress, trustee: SignerWithAddress
  let alice: SignerWithAddress, bob: SignerWithAddress, carol: SignerWithAddress, anyone: SignerWithAddress

  const ref = (s: string) => keccak256(toUtf8Bytes(s))
  const naira = (n: number) => BigInt(n) * 1_000_000n // cNGN has 6 decimals

  async function mint(to: SignerWithAddress, amount: bigint, tradeRef: string) {
    const deadline = BigInt((await time.latest()) + 3600)
    const domain = { name: "PawaEquityToken", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await token.getAddress() }
    const types = { MintAttestation: [
      { name: "to", type: "address" }, { name: "amount", type: "uint256" },
      { name: "tradeRef", type: "bytes32" }, { name: "deadline", type: "uint256" },
    ] }
    const sig = await custodian.signTypedData(domain, types, { to: to.address, amount, tradeRef, deadline })
    await token.connect(ops).mintWithAttestation(to.address, amount, tradeRef, deadline, sig)
  }

  // Registrar pays the pool, it is converted to cNGN and sent to the distributor; issuer declares.
  async function declare(snapshotId: bigint, total: bigint, fund = true) {
    if (fund) await cngn.connect(admin).mint(await dist.getAddress(), total)
    await dist.connect(ops).declare(snapshotId, total, "MTNN-FY2026-FINAL")
    return (await dist.dividendCount()) - 1n
  }

  beforeEach(async () => {
    ;[admin, custodian, ops, trustee, alice, bob, carol, anyone] = await ethers.getSigners()
    token = await (await ethers.getContractFactory("PawaEquityToken"))
      .deploy("PawaSave MTN Nigeria", "pMTNN", "MTNN", "NGMTNN000002", admin.address, custodian.address, 10_000n, 50_000n)
    for (const role of ["REGISTRAR_ROLE", "RECONCILER_ROLE", "BURNER_ROLE", "MINTER_ROLE", "SNAPSHOT_ROLE"]) {
      await token.connect(admin).grantRole(await token[role](), ops.address)
    }
    cngn = await (await ethers.getContractFactory("MockERC20")).deploy("cNGN", "cNGN", 6)
    dist = await (await ethers.getContractFactory("PawaDividendDistributor"))
      .deploy(await token.getAddress(), await cngn.getAddress(), admin.address)
    await dist.connect(admin).grantRole(await dist.ISSUER_ROLE(), ops.address)
    await dist.connect(admin).grantRole(await dist.TRUSTEE_ROLE(), trustee.address)

    await token.connect(ops).setVerifiedBatch([alice.address, bob.address, carol.address], true)
    await mint(alice, 60n, ref("T1"))
    await mint(bob, 40n, ref("T2"))
  })

  it("pays cNGN pro-rata to holders as at the record date", async () => {
    await token.connect(ops).snapshot("MTNN final dividend")
    const id = await declare(1n, naira(1000))
    await dist.connect(trustee).approve(id)

    await expect(dist.connect(anyone).pay(id, alice.address)).to.emit(dist, "DividendPaid").withArgs(id, alice.address, naira(600))
    await dist.connect(anyone).pay(id, bob.address)
    expect(await cngn.balanceOf(alice.address)).to.equal(naira(600))
    expect(await cngn.balanceOf(bob.address)).to.equal(naira(400))
    expect(await dist.committed()).to.equal(0n)
  })

  it("a transfer after the record date does not move the dividend", async () => {
    await token.connect(ops).snapshot("record date")
    await token.connect(alice).transfer(carol.address, 60n) // after the record date
    const id = await declare(1n, naira(1000))
    await dist.connect(trustee).approve(id)

    expect(await dist.entitlement(id, alice.address)).to.equal(naira(600))
    expect(await dist.entitlement(id, carol.address)).to.equal(0n)
    await expect(dist.pay(id, carol.address)).to.be.revertedWith("nothing due")
    await dist.pay(id, alice.address)
    expect(await cngn.balanceOf(alice.address)).to.equal(naira(600))
  })

  it("nobody is paid twice, and anyone can trigger a payment but only to the holder", async () => {
    await token.connect(ops).snapshot("record date")
    const id = await declare(1n, naira(1000))
    await dist.connect(trustee).approve(id)
    await dist.connect(anyone).pay(id, alice.address)
    await expect(dist.connect(alice).pay(id, alice.address)).to.be.revertedWith("already paid")
    expect(await cngn.balanceOf(anyone.address)).to.equal(0n)
  })

  it("cannot be paid before the trustee approves, and cannot be approved unfunded", async () => {
    await token.connect(ops).snapshot("record date")
    const id = await declare(1n, naira(1000), false)
    await expect(dist.pay(id, alice.address)).to.be.revertedWith("not payable")
    await expect(dist.connect(trustee).approve(id)).to.be.revertedWith("not funded")
    await expect(dist.connect(ops).approve(id)).to.be.reverted // the issuer cannot approve its own dividend
    await cngn.connect(admin).mint(await dist.getAddress(), naira(1000))
    await dist.connect(trustee).approve(id)
    await dist.pay(id, alice.address)
  })

  it("money held for one dividend cannot fund the approval of another", async () => {
    await token.connect(ops).snapshot("interim")
    const first = await declare(1n, naira(1000))
    await dist.connect(trustee).approve(first)
    const second = await declare(1n, naira(500), false)
    await expect(dist.connect(trustee).approve(second)).to.be.revertedWith("not funded")
  })

  it("tokens locked in a redemption at the record date still earn the dividend", async () => {
    await token.connect(bob).requestRedemption(10n, 0) // 10 of Bob's 40 locked, shares still in the pool
    await time.increase(60)
    await token.connect(ops).snapshot("record date")
    await time.increase(60)
    await token.connect(ops).completeRedemption(0, ref("sale")) // sold after the record date
    const id = await declare(1n, naira(1000))
    await dist.connect(trustee).approve(id)

    await dist.pay(id, bob.address)          // on the 30 in his wallet
    await dist.payLocked(id, 0)              // on the 10 that were locked
    expect(await cngn.balanceOf(bob.address)).to.equal(naira(400))
    await expect(dist.payLocked(id, 0)).to.be.revertedWith("already paid")
    await expect(dist.pay(id, await token.getAddress())).to.be.revertedWith("nothing due")
  })

  it("a redemption finished before, or started after, the record date earns nothing through the lock", async () => {
    await token.connect(bob).requestRedemption(10n, 0)
    await time.increase(60)
    await token.connect(ops).completeRedemption(0, ref("sale")) // gone before the record date
    await time.increase(60)
    await token.connect(ops).snapshot("record date")
    await time.increase(60)
    await token.connect(alice).requestRedemption(5n, 0)         // locked after the record date
    const id = await declare(1n, naira(900))
    await dist.connect(trustee).approve(id)

    await expect(dist.payLocked(id, 0)).to.be.revertedWith("not locked at record date")
    await expect(dist.payLocked(id, 1)).to.be.revertedWith("not locked at record date")
    await dist.pay(id, alice.address) // Alice still held all 60 at the record date
    expect(await cngn.balanceOf(alice.address)).to.equal(naira(600))
  })

  it("a holder removed from the register is not paid until that is resolved", async () => {
    await token.connect(ops).snapshot("record date")
    const id = await declare(1n, naira(1000))
    await dist.connect(trustee).approve(id)
    await token.connect(ops).setVerified(bob.address, false)
    await expect(dist.pay(id, bob.address)).to.be.revertedWith("holder not verified")
    await dist.payMany(id, [alice.address, bob.address]) // skips Bob, pays Alice
    expect(await cngn.balanceOf(alice.address)).to.equal(naira(600))
    await token.connect(ops).setVerified(bob.address, true)
    await dist.pay(id, bob.address)
    expect(await cngn.balanceOf(bob.address)).to.equal(naira(400))
  })

  it("rounds down and never pays out more than was received", async () => {
    await mint(carol, 3n, ref("T3")) // 103 tokens
    await token.connect(ops).snapshot("record date")
    const id = await declare(1n, 1_000_000n) // ₦1 across 103 tokens
    await dist.connect(trustee).approve(id)
    await dist.payMany(id, [alice.address, bob.address, carol.address])
    const d = await dist.dividends(id)
    expect(d.paid).to.be.lte(d.total)
    expect(await cngn.balanceOf(await dist.getAddress())).to.equal(d.total - d.paid)
  })

  it("only the issuer declares, only against a real record date; the trustee recovers unclaimed money after twelve months", async () => {
    await expect(dist.connect(ops).declare(1n, naira(1), "x")).to.be.revertedWith("no such record date")
    await token.connect(ops).snapshot("record date")
    await expect(dist.connect(anyone).declare(1n, naira(1), "x")).to.be.reverted
    const id = await declare(1n, naira(1000))
    await dist.connect(trustee).approve(id)
    await dist.pay(id, alice.address)
    await expect(dist.connect(trustee).close(id, trustee.address)).to.be.revertedWith("too early")
    await time.increase(366 * 24 * 3600)
    await expect(dist.connect(trustee).close(id, trustee.address)).to.emit(dist, "DividendClosed").withArgs(id, trustee.address, naira(400))
    await expect(dist.pay(id, bob.address)).to.be.revertedWith("not payable")
  })
})
