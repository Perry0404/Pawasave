import { expect } from "chai"
import { ethers } from "hardhat"
import { keccak256, toUtf8Bytes, ZeroHash } from "ethers"
import { time } from "@nomicfoundation/hardhat-network-helpers"
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"

// PSS-1 NGX equity token: every control the SEC response promises, proven.
describe("PawaEquityToken (NGX pilot)", function () {
  let token: any
  let admin: SignerWithAddress, custodian: SignerWithAddress, minter: SignerWithAddress
  let ops: SignerWithAddress, alice: SignerWithAddress, bob: SignerWithAddress, stranger: SignerWithAddress

  const ref = (s: string) => keccak256(toUtf8Bytes(s))

  async function attest(signer: SignerWithAddress, to: string, amount: bigint, tradeRef: string, deadline?: bigint) {
    const dl = deadline ?? BigInt((await time.latest()) + 3600)
    const domain = { name: "PawaEquityToken", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await token.getAddress() }
    const types = { MintAttestation: [
      { name: "to", type: "address" }, { name: "amount", type: "uint256" },
      { name: "tradeRef", type: "bytes32" }, { name: "deadline", type: "uint256" },
    ] }
    const sig = await signer.signTypedData(domain, types, { to, amount, tradeRef, deadline: dl })
    return { dl, sig }
  }

  async function mint(to: SignerWithAddress, amount: bigint, tradeRef: string, signer = custodian) {
    const { dl, sig } = await attest(signer, to.address, amount, tradeRef)
    return token.connect(minter).mintWithAttestation(to.address, amount, tradeRef, dl, sig)
  }

  beforeEach(async () => {
    ;[admin, custodian, minter, ops, alice, bob, stranger] = await ethers.getSigners()
    const F = await ethers.getContractFactory("PawaEquityToken")
    token = await F.deploy("PawaSave MTN Nigeria", "pMTNN", "MTNN", "NGMTNN000002", admin.address, custodian.address, 10_000n, 50_000n)
    for (const role of ["REGISTRAR_ROLE", "RECONCILER_ROLE", "BURNER_ROLE", "PAUSER_ROLE", "SNAPSHOT_ROLE"]) {
      await token.connect(admin).grantRole(await token[role](), ops.address)
    }
    await token.connect(admin).grantRole(await token.MINTER_ROLE(), minter.address)
    await token.connect(ops).setVerifiedBatch([alice.address, bob.address], true)
  })

  it("is whole shares only", async () => {
    expect(await token.decimals()).to.equal(0)
  })

  describe("minting only against custodian-attested settlement", () => {
    it("mints with a valid custodian attestation", async () => {
      await expect(mint(alice, 100n, ref("NGX-T1")))
        .to.emit(token, "MintedAgainstSettlement").withArgs(alice.address, 100n, ref("NGX-T1"))
      expect(await token.balanceOf(alice.address)).to.equal(100n)
    })
    it("rejects an attestation not signed by the custodian, even from the minting service itself", async () => {
      await expect(mint(alice, 100n, ref("NGX-T1"), minter)).to.be.revertedWith("not attested by custodian")
    })
    it("rejects a second mint for the same settled trade", async () => {
      await mint(alice, 100n, ref("NGX-T1"))
      await expect(mint(alice, 100n, ref("NGX-T1"))).to.be.revertedWith("trade already minted")
    })
    it("rejects tampering: a signature for 100 cannot mint 1,000", async () => {
      const { dl, sig } = await attest(custodian, alice.address, 100n, ref("NGX-T2"))
      await expect(token.connect(minter).mintWithAttestation(alice.address, 1000n, ref("NGX-T2"), dl, sig))
        .to.be.revertedWith("not attested by custodian")
    })
    it("rejects unverified recipients, expired attestations and non-minters", async () => {
      await expect(mint(stranger, 1n, ref("a"))).to.be.revertedWith("recipient not verified")
      const { sig } = await attest(custodian, alice.address, 1n, ref("b"), 1n)
      await expect(token.connect(minter).mintWithAttestation(alice.address, 1n, ref("b"), 1n, sig)).to.be.revertedWith("attestation expired")
      const { dl, sig: s2 } = await attest(custodian, alice.address, 1n, ref("c"))
      await expect(token.connect(alice).mintWithAttestation(alice.address, 1n, ref("c"), dl, s2)).to.be.reverted
    })
    it("enforces per-transaction and daily caps", async () => {
      await expect(mint(alice, 10_001n, ref("big"))).to.be.revertedWith("over per-tx cap")
      for (let i = 0; i < 5; i++) await mint(alice, 10_000n, ref("d" + i))
      await expect(mint(alice, 1n, ref("d5"))).to.be.revertedWith("over daily cap")
      await time.increase(86_400)
      await mint(alice, 1n, ref("d6"))
    })
  })

  describe("reconciliation", () => {
    it("a reserve shortfall halts minting until the pool is restored", async () => {
      await mint(alice, 100n, ref("t1"))
      await expect(token.connect(ops).reportReserve(90n, ref("stmt-1")))
        .to.emit(token, "ReserveReported").withArgs(90n, 100n, ref("stmt-1"), true)
      expect(await token.mintHalted()).to.equal(true)
      await expect(mint(alice, 1n, ref("t2"))).to.be.revertedWith("minting halted")
      await expect(token.connect(ops).setMintHalt(false, "")).to.be.revertedWith("reserve still short")
      await token.connect(ops).reportReserve(100n, ref("stmt-2"))
      await token.connect(ops).setMintHalt(false, "resolved")
      await mint(alice, 1n, ref("t2"))
    })
  })

  describe("transfers", () => {
    it("moves only between verified wallets", async () => {
      await mint(alice, 10n, ref("t1"))
      await token.connect(alice).transfer(bob.address, 4n)
      expect(await token.balanceOf(bob.address)).to.equal(4n)
      await expect(token.connect(alice).transfer(stranger.address, 1n)).to.be.revertedWith("transfer between unverified wallets")
    })

    it("cannot be sent to the token contract by hand, only through a redemption", async () => {
      // The exemption for moves in and out of this contract was unconditional, so a holder could
      // transfer straight to the token address. The tokens left their wallet with no Redemption
      // record: nothing could complete or cancel them, lockedSupply never counted them, and they
      // stayed in totalSupply so the custodian had to keep shares against them indefinitely.
      await mint(alice, 100n, ref("t1"))
      await expect(token.connect(alice).transfer(await token.getAddress(), 40n))
        .to.be.revertedWith("use requestRedemption")

      // And the legitimate route still works.
      await token.connect(alice).requestRedemption(40n, 0)
      expect(await token.balanceOf(await token.getAddress())).to.equal(40n)
      expect(await token.lockedSupply()).to.equal(40n)
      expect(await token.redemptionCount()).to.equal(1n)
    })

    it("stranded tokens would have made part of every dividend unreachable", async () => {
      // Why the rule above matters beyond tidiness. Tokens sitting at the token address are counted
      // in totalSupplyAt, so they take a share of the record-date split, but entitlement() returns
      // zero for that address and no payLocked can claim them. The slice is simply unpayable.
      await mint(alice, 100n, ref("t1"))
      await token.connect(alice).requestRedemption(20n, 0)
      await token.connect(ops).snapshot("FY2026 final")

      // 20 of 100 sit in the contract, and they are reachable only because a Redemption records
      // whose they are.
      expect(await token.balanceOfAt(await token.getAddress(), 1n)).to.equal(20n)
      const r = await token.redemptions(0)
      expect(r.holder).to.equal(alice.address)
      expect(r.amount).to.equal(20n)
    })
    it("stops when a holder is de-registered or the token is paused", async () => {
      await mint(alice, 10n, ref("t1"))
      await token.connect(ops).setVerified(alice.address, false)
      await expect(token.connect(alice).transfer(bob.address, 1n)).to.be.revertedWith("transfer between unverified wallets")
      await token.connect(ops).setVerified(alice.address, true)
      await token.connect(ops).pause()
      await expect(token.connect(alice).transfer(bob.address, 1n)).to.be.revertedWith("paused")
    })
    it("forced transfer needs the admin and a legal basis, and the admin gets no other bypass", async () => {
      await mint(alice, 10n, ref("t1"))
      await expect(token.connect(ops).forcedTransfer(alice.address, bob.address, 1n, "court order")).to.be.reverted
      await expect(token.connect(admin).forcedTransfer(alice.address, bob.address, 1n, "")).to.be.revertedWith("legal basis required")
      await expect(token.connect(admin).forcedTransfer(alice.address, bob.address, 2n, "FHC/L/CS/1/2027"))
        .to.emit(token, "ForcedTransfer")
      // The admin wallet holding tokens gets no bypass on a plain transfer.
      await token.connect(ops).setVerified(admin.address, true)
      await token.connect(admin).forcedTransfer(alice.address, admin.address, 1n, "test setup")
      await token.connect(ops).setVerified(admin.address, false)
      await expect(token.connect(admin).transfer(bob.address, 1n)).to.be.revertedWith("transfer between unverified wallets")
    })
  })

  describe("redemption: lock, then burn", () => {
    it("locks on request and burns only after settlement", async () => {
      await mint(alice, 50n, ref("t1"))
      await expect(token.connect(alice).requestRedemption(20n, 0)).to.emit(token, "RedemptionRequested").withArgs(0n, alice.address, 20n, 0)
      expect(await token.balanceOf(alice.address)).to.equal(30n)
      expect(await token.lockedSupply()).to.equal(20n)
      expect(await token.totalSupply()).to.equal(50n) // still backed until the sale settles
      await token.connect(ops).completeRedemption(0, ref("NGX-SALE-1"))
      expect(await token.totalSupply()).to.equal(30n)
      expect(await token.lockedSupply()).to.equal(0n)
      await expect(token.connect(ops).completeRedemption(0, ZeroHash)).to.be.revertedWith("not pending")
    })
    it("returns tokens in full if settlement fails", async () => {
      await mint(alice, 50n, ref("t1"))
      await token.connect(alice).requestRedemption(50n, 1)
      await expect(token.connect(ops).cancelRedemption(0, "failed settlement")).to.emit(token, "RedemptionCancelled")
      expect(await token.balanceOf(alice.address)).to.equal(50n)
      expect(await token.totalSupply()).to.equal(50n)
    })
    it("only verified holders can redeem, and only the burner can complete", async () => {
      await mint(alice, 5n, ref("t1"))
      await token.connect(alice).requestRedemption(5n, 0)
      await expect(token.connect(alice).completeRedemption(0, ZeroHash)).to.be.reverted
      await token.connect(ops).setVerified(alice.address, false)
      await expect(token.connect(alice).requestRedemption(1n, 0)).to.be.revertedWith("holder not verified")
    })
  })

  describe("corporate actions and keys", () => {
    it("records a 2-for-1 bonus through the multiplier without moving balances", async () => {
      await mint(alice, 10n, ref("t1"))
      await expect(token.connect(admin).setMultiplier(2n * 10n ** 18n, "1-for-1 bonus issue"))
        .to.emit(token, "MultiplierChanged")
      expect(await token.balanceOf(alice.address)).to.equal(10n)
      expect(await token.multiplier()).to.equal(2n * 10n ** 18n)
    })
    it("a bonus issue that outruns the pool halts minting there and then", async () => {
      // The contract creates this shortfall itself, so it must not wait for the next daily reserve
      // report to notice. Before, minting stayed open and 50 more could be issued against a pool
      // the contract already knew was 100 short.
      await mint(alice, 100n, ref("NGX-T1"))
      await token.connect(ops).reportReserve(100n, ref("stmt-1"))
      expect(await token.mintHalted()).to.equal(false)

      await expect(token.connect(admin).setMultiplier(2n * 10n ** 18n, "1-for-1 bonus"))
        .to.emit(token, "MintHaltChanged").withArgs(true, "reserve shortfall after corporate action")

      expect(await token.sharesRequired()).to.equal(200n)
      await expect(mint(bob, 50n, ref("NGX-T2"))).to.be.revertedWith("minting halted")

      // Resumes once the custodian credits the bonus shares.
      await token.connect(ops).reportReserve(200n, ref("stmt-bonus-credited"))
      await token.connect(ops).setMintHalt(false, "bonus shares credited")
      await mint(bob, 50n, ref("NGX-T2"))
      expect(await token.balanceOf(bob.address)).to.equal(50n)
    })

    it("a split that the pool already covers does not halt anything", async () => {
      // The halt is for a genuine shortfall, not for every corporate action.
      await mint(alice, 100n, ref("NGX-T1"))
      await token.connect(ops).reportReserve(400n, ref("stmt-ample"))
      await token.connect(admin).setMultiplier(2n * 10n ** 18n, "1-for-1 bonus")
      expect(await token.mintHalted()).to.equal(false)
    })

    it("after a bonus issue the reserve check counts shares, not tokens", async () => {
      await mint(alice, 100n, ref("NGX-T1"))
      await token.connect(admin).setMultiplier(2n * 10n ** 18n, "1-for-1 bonus")
      expect(await token.sharesRequired()).to.equal(200n)
      // The pool still holds only the pre-bonus 100 shares: that is a shortfall.
      await expect(token.connect(ops).reportReserve(100n, ref("stmt-bonus")))
        .to.emit(token, "ReserveReported").withArgs(100n, 100n, ref("stmt-bonus"), true)
      expect(await token.mintHalted()).to.equal(true)
      await expect(token.connect(ops).setMintHalt(false, "too early")).to.be.revertedWith("reserve still short")
      await token.connect(ops).reportReserve(200n, ref("stmt-bonus-credited"))
      await token.connect(ops).setMintHalt(false, "bonus shares credited")
      expect(await token.mintHalted()).to.equal(false)
    })
    it("rotating the custodian key invalidates attestations from the old key", async () => {
      await token.connect(admin).setCustodianSigner(stranger.address)
      await expect(mint(alice, 1n, ref("t1"))).to.be.revertedWith("not attested by custodian")
      await mint(alice, 1n, ref("t1"), stranger)
    })
  })
})
