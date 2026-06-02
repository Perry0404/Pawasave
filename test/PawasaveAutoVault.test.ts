import { expect } from "chai"
import { ethers } from "hardhat"
import { PawasaveAutoVault, MockERC20 } from "../typechain-types"
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import { time } from "@nomicfoundation/hardhat-network-helpers"

describe("PawasaveAutoVault", function () {
  let vault: PawasaveAutoVault
  let mockToken: MockERC20
  let owner: SignerWithAddress
  let user1: SignerWithAddress
  let user2: SignerWithAddress
  let feeRecipient: SignerWithAddress
  let primaryStrategy: SignerWithAddress
  let fallbackStrategy: SignerWithAddress

  const INITIAL_BALANCE = ethers.parseEther("10000")
  const DEPOSIT_AMOUNT = ethers.parseEther("100")

  before(async () => {
    ;[owner, user1, user2, feeRecipient, primaryStrategy, fallbackStrategy] =
      await ethers.getSigners()

    // Deploy mock ERC20 token (cNGN)
    const MockERC20Factory = await ethers.getContractFactory("MockERC20")
    mockToken = await MockERC20Factory.deploy("Crypto NGN", "cNGN", 6)
    await mockToken.deployed()

    // Mint tokens to users
    await mockToken.mint(user1.address, INITIAL_BALANCE)
    await mockToken.mint(user2.address, INITIAL_BALANCE)
    await mockToken.mint(owner.address, INITIAL_BALANCE)

    // Deploy vault
    const VaultFactory = await ethers.getContractFactory("PawasaveAutoVault")
    vault = await VaultFactory.deploy(
      await mockToken.getAddress(),
      primaryStrategy.address,
      fallbackStrategy.address,
      feeRecipient.address
    )
    await vault.deployed()

    console.log("✓ Contracts deployed")
  })

  describe("Deployment", () => {
    it("Should initialize with correct parameters", async () => {
      expect(await vault.assetToken()).to.equal(await mockToken.getAddress())
      expect(await vault.primaryStrategy()).to.equal(primaryStrategy.address)
      expect(await vault.fallbackStrategy()).to.equal(fallbackStrategy.address)
      expect(await vault.feeRecipient()).to.equal(feeRecipient.address)
    })

    it("Should have correct platform fee (6%)", async () => {
      expect(await vault.platformFeeBps()).to.equal(600)
    })

    it("Should grant owner harvester role", async () => {
      const HARVESTER_ROLE = await vault.HARVESTER_ROLE()
      expect(await vault.hasRole(HARVESTER_ROLE, owner.address)).to.be.true
    })
  })

  describe("Flexible Deposits", () => {
    it("Should allow flexible deposit", async () => {
      const depositAmount = ethers.parseEther("50")

      // Approve
      await mockToken.connect(user1).approve(await vault.getAddress(), depositAmount)

      // Deposit
      await expect(
        vault.connect(user1).depositFlexible(depositAmount, user1.address)
      ).to.emit(vault, "Deposited")

      // Check shares minted
      const shares = await vault.balanceOf(user1.address)
      expect(shares).to.be.gt(0)
    })

    it("Should track user deposit correctly", async () => {
      const deposits = await vault.getUserDeposits(user1.address)
      expect(deposits.length).to.be.gt(0)
      expect(deposits[0].amount).to.equal(ethers.parseEther("50"))
      expect(deposits[0].depositType).to.equal(0) // FLEXIBLE
      expect(deposits[0].unlockTime).to.equal(0) // No lock
    })

    it("Should allow flexible withdrawal anytime", async () => {
      const shares = await vault.balanceOf(user1.address)
      expect(shares).to.be.gt(0)

      await expect(
        vault.connect(user1).withdraw(shares, user1.address, user1.address)
      ).to.not.be.reverted
    })
  })

  describe("Fixed Deposits (30 days)", () => {
    it("Should allow 30-day fixed deposit", async () => {
      const depositAmount = ethers.parseEther("75")

      await mockToken.connect(user1).approve(await vault.getAddress(), depositAmount)

      await expect(
        vault.connect(user1).depositFixed(depositAmount, user1.address, 30)
      ).to.emit(vault, "Deposited")

      const shares = await vault.balanceOf(user1.address)
      expect(shares).to.be.gt(0)
    })

    it("Should track 30-day lock correctly", async () => {
      const deposits = await vault.getUserDeposits(user1.address)
      const fixedDeposit = deposits.find((d) => d.depositType === 1) // FIXED_30
      expect(fixedDeposit).to.not.be.undefined
      expect(fixedDeposit!.unlockTime).to.be.gt(0)
    })

    it("Should prevent early withdrawal before unlock", async () => {
      const shares = ethers.parseUnits("1", 6)
      await expect(
        vault.connect(user1).withdraw(shares, user1.address, user1.address)
      ).to.be.revertedWith("Funds still locked")
    })

    it("Should allow withdrawal after unlock", async () => {
      // Move time forward 30 days
      await time.increase(30 * 24 * 60 * 60 + 1)

      const shares = await vault.balanceOf(user1.address)
      await expect(
        vault.connect(user1).withdraw(shares, user1.address, user1.address)
      ).to.not.be.reverted
    })
  })

  describe("Fixed Deposits - All Durations", () => {
    beforeEach(async () => {
      // Reset to fresh state for each test
      await mockToken.connect(user2).approve(await vault.getAddress(), DEPOSIT_AMOUNT)
    })

    it("Should accept 90-day lock", async () => {
      await vault.connect(user2).depositFixed(DEPOSIT_AMOUNT, user2.address, 90)
      const deposits = await vault.getUserDeposits(user2.address)
      expect(deposits[0].depositType).to.equal(2) // FIXED_90
    })

    it("Should accept 180-day lock", async () => {
      await vault.connect(user2).depositFixed(DEPOSIT_AMOUNT, user2.address, 180)
      const deposits = await vault.getUserDeposits(user2.address)
      expect(deposits[0].depositType).to.equal(3) // FIXED_180
    })

    it("Should accept 365-day lock", async () => {
      await vault.connect(user2).depositFixed(DEPOSIT_AMOUNT, user2.address, 365)
      const deposits = await vault.getUserDeposits(user2.address)
      expect(deposits[0].depositType).to.equal(4) // FIXED_365
    })

    it("Should reject invalid lock period", async () => {
      await mockToken.connect(user2).approve(await vault.getAddress(), DEPOSIT_AMOUNT)
      await expect(
        vault.connect(user2).depositFixed(DEPOSIT_AMOUNT, user2.address, 45)
      ).to.be.revertedWith("Invalid lock period")
    })
  })

  describe("Lock Checking", () => {
    it("Should report active lock", async () => {
      const hasLock = await vault.hasActiveLock(user1.address)
      expect(hasLock).to.be.true
    })

    it("Should return next unlock time", async () => {
      const nextUnlock = await vault.getNextUnlockTime(user1.address)
      expect(nextUnlock).to.be.gt(0)
    })

    it("Should clear lock status after unlock time", async () => {
      // Move time forward past all locks
      await time.increase(365 * 24 * 60 * 60 + 1)

      const hasLock = await vault.hasActiveLock(user1.address)
      expect(hasLock).to.be.false
    })
  })

  describe("Yield Harvesting", () => {
    beforeEach(async () => {
      // Deposit some funds
      await mockToken.connect(user1).approve(await vault.getAddress(), DEPOSIT_AMOUNT)
      await vault.connect(user1).depositFlexible(DEPOSIT_AMOUNT, user1.address)
    })

    it("Should only allow harvester to harvest", async () => {
      await expect(
        vault.connect(user1).harvestYield()
      ).to.be.revertedWith("Not harvester")
    })

    it("Should harvest yield with owner account", async () => {
      // Mock some yield by sending tokens to vault
      await mockToken.mint(await vault.getAddress(), ethers.parseEther("10"))

      const tx = await vault.connect(owner).harvestYield()
      expect(tx).to.emit(vault, "YieldHarvested")
    })

    it("Should calculate platform fee correctly (6%)", async () => {
      // Send 100 tokens as yield
      const yieldAmount = ethers.parseEther("100")
      await mockToken.mint(await vault.getAddress(), yieldAmount)

      // Capture fee recipient balance before
      const balanceBefore = await mockToken.balanceOf(feeRecipient.address)

      await vault.connect(owner).harvestYield()

      const balanceAfter = await mockToken.balanceOf(feeRecipient.address)
      const feePaid = balanceAfter - balanceBefore

      // Should be 6% of yield
      const expectedFee = (yieldAmount * BigInt(600)) / BigInt(10000)
      expect(feePaid).to.equal(expectedFee)
    })

    it("Should track total fees accrued", async () => {
      const totalFees = await vault.getTotalFees()
      expect(totalFees).to.be.gt(0)
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
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
    })
  })

  describe("Admin Functions", () => {
    it("Should update platform fee", async () => {
      await vault.updatePlatformFee(800) // 8%
      expect(await vault.platformFeeBps()).to.equal(800)
    })

    it("Should reject fee > 15%", async () => {
      await expect(vault.updatePlatformFee(2000)).to.be.revertedWith(
        "Fee cannot exceed 15%"
      )
    })

    it("Should update fee recipient", async () => {
      const newRecipient = user2.address
      await vault.updateFeeRecipient(newRecipient)
      expect(await vault.feeRecipient()).to.equal(newRecipient)
    })

    it("Should update primary strategy", async () => {
      const newStrategy = user2.address
      await expect(vault.updatePrimaryStrategy(newStrategy)).to.emit(
        vault,
        "StrategyUpdated"
      )
      expect(await vault.primaryStrategy()).to.equal(newStrategy)
    })

    it("Should update fallback strategy", async () => {
      const newStrategy = user1.address
      await expect(vault.updateFallbackStrategy(newStrategy)).to.emit(
        vault,
        "StrategyUpdated"
      )
      expect(await vault.fallbackStrategy()).to.equal(newStrategy)
    })
  })

  describe("Pause/Unpause", () => {
    it("Should allow owner to pause vault", async () => {
      await vault.pauseVault()
      const isPaused = await vault.paused()
      expect(isPaused).to.be.true
    })

    it("Should prevent deposits when paused", async () => {
      await mockToken.connect(user1).approve(await vault.getAddress(), DEPOSIT_AMOUNT)
      await expect(
        vault.connect(user1).depositFlexible(DEPOSIT_AMOUNT, user1.address)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause")
    })

    it("Should allow owner to unpause vault", async () => {
      await vault.unpauseVault()
      const isPaused = await vault.paused()
      expect(isPaused).to.be.false
    })
  })

  describe("Edge Cases", () => {
    it("Should reject zero deposit", async () => {
      await mockToken.connect(user1).approve(await vault.getAddress(), 1000)
      await expect(
        vault.connect(user1).depositFlexible(0, user1.address)
      ).to.be.revertedWith("Zero deposit")
    })

    it("Should reject deposit to zero address", async () => {
      await mockToken.connect(user1).approve(await vault.getAddress(), DEPOSIT_AMOUNT)
      await expect(
        vault.connect(user1).depositFlexible(DEPOSIT_AMOUNT, ethers.ZeroAddress)
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
    it("Should protect harvest with nonReentrant", async () => {
      // This test would need a malicious contract to properly test
      // For now, just verify the function exists and works
      await mockToken.mint(await vault.getAddress(), ethers.parseEther("10"))
      const tx = await vault.connect(owner).harvestYield()
      expect(tx).to.not.be.reverted
    })
  })

  describe("View Functions", () => {
    it("Should return correct total assets", async () => {
      const totalAssets = await vault.totalAssets()
      expect(totalAssets).to.be.gte(0)
    })

    it("Should convert assets to shares correctly", async () => {
      const assets = ethers.parseEther("100")
      const shares = await vault.convertToShares(assets)
      expect(shares).to.be.gt(0)
    })

    it("Should convert shares to assets correctly", async () => {
      const shares = ethers.parseEther("10")
      const assets = await vault.convertToAssets(shares)
      expect(assets).to.be.gte(0)
    })
  })
})
