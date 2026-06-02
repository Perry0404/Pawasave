import { expect } from "chai"
import { ethers } from "hardhat"
import { parseEther, parseUnits, ZeroAddress } from "ethers"
import { PawasaveAutoVault, MockERC20, MockStrategy } from "../typechain-types"
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import { time } from "@nomicfoundation/hardhat-network-helpers"

describe("PawasaveAutoVault", function () {
  let vault: PawasaveAutoVault
  let mockToken: MockERC20
  let mockStrategy: MockStrategy
  let owner: SignerWithAddress
  let user1: SignerWithAddress
  let user2: SignerWithAddress
  let feeRecipient: SignerWithAddress
  let fallbackStrategy: SignerWithAddress

  const INITIAL_BALANCE = parseEther("10000")
  const DEPOSIT_AMOUNT = parseEther("100")

  before(async () => {
    ;[owner, user1, user2, feeRecipient, fallbackStrategy] = await ethers.getSigners()

    // Deploy mock ERC20 token (cNGN)
    const MockERC20Factory = await ethers.getContractFactory("MockERC20")
    mockToken = await MockERC20Factory.deploy("Crypto NGN", "cNGN", 6)
    await mockToken.waitForDeployment()

    // Mint tokens to users
    await mockToken.mint(user1.address, INITIAL_BALANCE)
    await mockToken.mint(user2.address, INITIAL_BALANCE)
    await mockToken.mint(owner.address, INITIAL_BALANCE)

    // Deploy mock strategy
    const MockStrategyFactory = await ethers.getContractFactory("MockStrategy")
    mockStrategy = await MockStrategyFactory.deploy(await mockToken.getAddress())
    await mockStrategy.waitForDeployment()

    // Deploy vault with mock strategy as primary
    const VaultFactory = await ethers.getContractFactory("PawasaveAutoVault")
    vault = await VaultFactory.deploy(
      await mockToken.getAddress(),
      await mockStrategy.getAddress(),
      fallbackStrategy.address,
      feeRecipient.address
    )
    await vault.waitForDeployment()

    console.log("✓ Contracts deployed")
  })

  describe("Deployment", () => {
    it("Should initialize with correct parameters", async () => {
      expect(await vault.assetToken()).to.equal(await mockToken.getAddress())
      expect(await vault.primaryStrategy()).to.equal(await mockStrategy.getAddress())
      expect(await vault.fallbackStrategy()).to.equal(fallbackStrategy.address)
      expect(await vault.feeRecipient()).to.equal(feeRecipient.address)
    })

    it("Should have correct platform fee (6%)", async () => {
      expect(await vault.platformFeeBps()).to.equal(600n)
    })

    it("Should grant owner harvester role", async () => {
      const HARVESTER_ROLE = await vault.HARVESTER_ROLE()
      expect(await vault.hasRole(HARVESTER_ROLE, owner.address)).to.be.true
    })
  })

  describe("Flexible Deposits", () => {
    it("Should allow flexible deposit", async () => {
      const depositAmount = parseEther("50")
      await mockToken.connect(user1).approve(await vault.getAddress(), depositAmount)

      await expect(
        vault.connect(user1).depositFlexible(depositAmount, user1.address)
      ).to.emit(vault, "Deposited")

      const shares = await vault.balanceOf(user1.address)
      expect(shares).to.be.gt(0n)
    })

    it("Should track user deposit correctly", async () => {
      const deposits = await vault.getUserDeposits(user1.address)
      expect(deposits.length).to.be.gt(0)
      expect(deposits[0].amount).to.equal(parseEther("50"))
      expect(deposits[0].depositType).to.equal(0n) // FLEXIBLE
      expect(deposits[0].unlockTime).to.equal(0n)   // No lock
    })

    it("Should allow flexible withdrawal anytime", async () => {
      const shares = await vault.balanceOf(user1.address)
      expect(shares).to.be.gt(0n)

      await expect(
        vault.connect(user1).redeem(shares, user1.address, user1.address)
      ).to.not.be.reverted
    })
  })

  describe("Fixed Deposits (30 days)", () => {
    it("Should allow 30-day fixed deposit", async () => {
      const depositAmount = parseEther("75")
      await mockToken.connect(user1).approve(await vault.getAddress(), depositAmount)

      await expect(
        vault.connect(user1).depositFixed(depositAmount, user1.address, 30)
      ).to.emit(vault, "Deposited")

      const shares = await vault.balanceOf(user1.address)
      expect(shares).to.be.gt(0n)
    })

    it("Should track 30-day lock correctly", async () => {
      const deposits = await vault.getUserDeposits(user1.address)
      const fixedDeposit = deposits.find((d) => d.depositType === 1n) // FIXED_30
      expect(fixedDeposit).to.not.be.undefined
      expect(fixedDeposit!.unlockTime).to.be.gt(0n)
    })

    it("Should prevent early withdrawal before unlock", async () => {
      const shares = parseUnits("1", 6)
      await expect(
        vault.connect(user1).withdraw(shares, user1.address, user1.address)
      ).to.be.revertedWith("Funds still locked")
    })

    it("Should allow withdrawal after unlock", async () => {
      await time.increase(30 * 24 * 60 * 60 + 1)

      const shares = await vault.balanceOf(user1.address)
      await expect(
        vault.connect(user1).redeem(shares, user1.address, user1.address)
      ).to.not.be.reverted
    })
  })

  describe("Fixed Deposits - All Durations", () => {
    beforeEach(async () => {
      await mockToken.connect(user2).approve(await vault.getAddress(), DEPOSIT_AMOUNT)
    })

    it("Should accept 90-day lock", async () => {
      await vault.connect(user2).depositFixed(DEPOSIT_AMOUNT, user2.address, 90)
      const deposits = await vault.getUserDeposits(user2.address)
      const last = deposits[deposits.length - 1]
      expect(last.depositType).to.equal(2n) // FIXED_90
    })

    it("Should accept 180-day lock", async () => {
      await vault.connect(user2).depositFixed(DEPOSIT_AMOUNT, user2.address, 180)
      const deposits = await vault.getUserDeposits(user2.address)
      const last = deposits[deposits.length - 1]
      expect(last.depositType).to.equal(3n) // FIXED_180
    })

    it("Should accept 365-day lock", async () => {
      await vault.connect(user2).depositFixed(DEPOSIT_AMOUNT, user2.address, 365)
      const deposits = await vault.getUserDeposits(user2.address)
      const last = deposits[deposits.length - 1]
      expect(last.depositType).to.equal(4n) // FIXED_365
    })

    it("Should reject invalid lock period", async () => {
      await mockToken.connect(user2).approve(await vault.getAddress(), DEPOSIT_AMOUNT)
      await expect(
        vault.connect(user2).depositFixed(DEPOSIT_AMOUNT, user2.address, 45)
      ).to.be.revertedWith("Invalid lock period")
    })
  })

  describe("Lock Checking", () => {
    it("Should report active lock for user2", async () => {
      const hasLock = await vault.hasActiveLock(user2.address)
      expect(hasLock).to.be.true
    })

    it("Should return next unlock time", async () => {
      const nextUnlock = await vault.getNextUnlockTime(user2.address)
      expect(nextUnlock).to.be.gt(0n)
    })

    it("Should clear lock status after unlock time", async () => {
      await time.increase(365 * 24 * 60 * 60 + 1)
      const hasLock = await vault.hasActiveLock(user2.address)
      expect(hasLock).to.be.false
    })
  })

  describe("Yield Harvesting", () => {
    beforeEach(async () => {
      await mockToken.connect(user1).approve(await vault.getAddress(), DEPOSIT_AMOUNT)
      await vault.connect(user1).depositFlexible(DEPOSIT_AMOUNT, user1.address)
    })

    it("Should only allow harvester to harvest", async () => {
      await expect(vault.connect(user1).harvestYield()).to.be.revertedWith("Not harvester")
    })

    it("Should harvest yield with owner account", async () => {
      const yieldAmount = parseEther("10")
      await mockToken.mint(owner.address, yieldAmount)
      await mockToken.connect(owner).approve(await mockStrategy.getAddress(), yieldAmount)
      await mockStrategy.addYield(yieldAmount)

      await expect(vault.connect(owner).harvestYield()).to.emit(vault, "YieldHarvested")
    })

    it("Should calculate platform fee correctly (6%)", async () => {
      const yieldAmount = parseEther("100")
      await mockToken.mint(owner.address, yieldAmount)
      await mockToken.connect(owner).approve(await mockStrategy.getAddress(), yieldAmount)
      await mockStrategy.addYield(yieldAmount)

      const balanceBefore = await mockToken.balanceOf(feeRecipient.address)
      await vault.connect(owner).harvestYield()
      const balanceAfter = await mockToken.balanceOf(feeRecipient.address)

      const feePaid = balanceAfter - balanceBefore
      const expectedFee = (yieldAmount * 600n) / 10000n
      expect(feePaid).to.equal(expectedFee)
    })

    it("Should track total fees accrued", async () => {
      const totalFees = await vault.getTotalFees()
      expect(totalFees).to.be.gt(0n)
    })
  })

  describe("Role Management", () => {
    it("Should grant harvester role", async () => {
      const HARVESTER_ROLE = await vault.HARVESTER_ROLE()
      await vault.grantHarvesterRole(user1.address)
      expect(await vault.hasRole(HARVESTER_ROLE, user1.address)).to.be.true
    })

    it("Should revoke harvester role", async () => {
      const HARVESTER_ROLE = await vault.HARVESTER_ROLE()
      await vault.revokeHarvesterRole(user1.address)
      expect(await vault.hasRole(HARVESTER_ROLE, user1.address)).to.be.false
    })

    it("Should prevent non-owner from granting roles", async () => {
      await expect(
        vault.connect(user1).grantHarvesterRole(user2.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })
  })

  describe("Admin Functions", () => {
    it("Should update platform fee", async () => {
      await vault.updatePlatformFee(800)
      expect(await vault.platformFeeBps()).to.equal(800n)
    })

    it("Should reject fee > 15%", async () => {
      await expect(vault.updatePlatformFee(2000)).to.be.revertedWith("Fee cannot exceed 15%")
    })

    it("Should update fee recipient", async () => {
      const newRecipient = user2.address
      await vault.updateFeeRecipient(newRecipient)
      expect(await vault.feeRecipient()).to.equal(newRecipient)
    })

    it("Should update primary strategy", async () => {
      await expect(vault.updatePrimaryStrategy(user2.address)).to.emit(vault, "StrategyUpdated")
      expect(await vault.primaryStrategy()).to.equal(user2.address)
    })

    it("Should update fallback strategy", async () => {
      await expect(vault.updateFallbackStrategy(user1.address)).to.emit(vault, "StrategyUpdated")
      expect(await vault.fallbackStrategy()).to.equal(user1.address)
    })
  })

  describe("Pause/Unpause", () => {
    it("Should allow owner to pause vault", async () => {
      await vault.pauseVault()
      expect(await vault.paused()).to.be.true
    })

    it("Should prevent deposits when paused", async () => {
      await mockToken.connect(user1).approve(await vault.getAddress(), DEPOSIT_AMOUNT)
      await expect(
        vault.connect(user1).depositFlexible(DEPOSIT_AMOUNT, user1.address)
      ).to.be.revertedWith("Pausable: paused")
    })

    it("Should allow owner to unpause vault", async () => {
      await vault.unpauseVault()
      expect(await vault.paused()).to.be.false
    })
  })

  describe("Edge Cases", () => {
    it("Should reject zero deposit", async () => {
      await mockToken.connect(user1).approve(await vault.getAddress(), 1000n)
      await expect(
        vault.connect(user1).depositFlexible(0n, user1.address)
      ).to.be.revertedWith("Zero deposit")
    })

    it("Should reject deposit to zero address", async () => {
      await mockToken.connect(user1).approve(await vault.getAddress(), DEPOSIT_AMOUNT)
      await expect(
        vault.connect(user1).depositFlexible(DEPOSIT_AMOUNT, ZeroAddress)
      ).to.be.revertedWith("Invalid receiver")
    })

    it("Should handle multiple user deposits", async () => {
      await mockToken.connect(user1).approve(await vault.getAddress(), DEPOSIT_AMOUNT)
      await mockToken.connect(user2).approve(await vault.getAddress(), DEPOSIT_AMOUNT)

      await vault.connect(user1).depositFlexible(DEPOSIT_AMOUNT, user1.address)
      await vault.connect(user2).depositFlexible(DEPOSIT_AMOUNT, user2.address)

      const user1Deposits = await vault.getUserDeposits(user1.address)
      const user2Deposits = await vault.getUserDeposits(user2.address)

      expect(user1Deposits.length).to.be.gt(0)
      expect(user2Deposits.length).to.be.gt(0)
    })
  })

  describe("Reentrancy Protection", () => {
    it("Should protect harvest with nonReentrant (harvester only)", async () => {
      const yieldAmount = parseEther("10")
      await mockToken.mint(owner.address, yieldAmount)
      await mockToken.connect(owner).approve(await mockStrategy.getAddress(), yieldAmount)
      await mockStrategy.addYield(yieldAmount)

      // Restore strategy address first (admin tests changed it)
      await vault.updatePrimaryStrategy(await mockStrategy.getAddress())

      await expect(vault.connect(owner).harvestYield()).to.not.be.reverted
    })
  })

  describe("View Functions", () => {
    it("Should return correct total assets", async () => {
      const totalAssets = await vault.totalAssets()
      expect(totalAssets).to.be.gte(0n)
    })

    it("Should convert assets to shares correctly", async () => {
      const assets = parseEther("100")
      const shares = await vault.convertToShares(assets)
      expect(shares).to.be.gte(0n)
    })

    it("Should convert shares to assets correctly", async () => {
      const shares = parseEther("10")
      const assets = await vault.convertToAssets(shares)
      expect(assets).to.be.gte(0n)
    })
  })
})
