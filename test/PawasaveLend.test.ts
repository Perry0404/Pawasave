import { expect } from "chai"
import { ethers } from "hardhat"
import { parseEther, parseUnits, ZeroAddress } from "ethers"
import {
  PawasaveLend,
  InterestRateModel,
  PriceOracle,
  MockERC20,
} from "../typechain-types"
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import { time } from "@nomicfoundation/hardhat-network-helpers"

describe("PawasaveLend", function () {
  let lend: PawasaveLend
  let irm: InterestRateModel
  let oracle: PriceOracle
  let cNGN: MockERC20
  let usdc: MockERC20

  let owner: SignerWithAddress
  let treasury: SignerWithAddress
  let supplier1: SignerWithAddress
  let supplier2: SignerWithAddress
  let borrower1: SignerWithAddress
  let borrower2: SignerWithAddress
  let liquidator: SignerWithAddress
  let keeper: SignerWithAddress

  // 1 USDC = 1,650 cNGN (representative NGN/USD rate)
  // price = cNGN (1e6) per 1e18 normalised USDC
  // 1 USDC = 1e6 units, normalised to 1e18 = 1e12
  // 1 cNGN per normalised = 1e6
  // 1 USDC → 1650 cNGN → price = 1650 * 1e6 = 1650_000_000
  const USDC_PRICE = parseUnits("1650", 6) // 1650 cNGN per 1e18 normalised USDC

  const CNGN_SUPPLY   = parseUnits("1000000", 6) // 1M cNGN
  const USDC_SUPPLY   = parseUnits("10000",   6) // 10k USDC
  const SUPPLY_AMOUNT = parseUnits("100000",  6) // 100k cNGN supplied
  const COLLATERAL    = parseUnits("100",     6) // 100 USDC collateral = 165,000 cNGN
  const BORROW_AMOUNT = parseUnits("100000",  6) // 100k cNGN borrow

  before(async () => {
    ;[owner, treasury, supplier1, supplier2, borrower1, borrower2, liquidator, keeper] =
      await ethers.getSigners()

    // Deploy tokens
    const ERC20F = await ethers.getContractFactory("MockERC20")
    cNGN = await ERC20F.deploy("Crypto NGN", "cNGN", 6)
    await cNGN.waitForDeployment()
    usdc = await ERC20F.deploy("USD Coin", "USDC", 6)
    await usdc.waitForDeployment()

    // Mint
    await cNGN.mint(supplier1.address, CNGN_SUPPLY)
    await cNGN.mint(supplier2.address, CNGN_SUPPLY)
    await cNGN.mint(borrower1.address, CNGN_SUPPLY) // for repayment
    await cNGN.mint(liquidator.address, CNGN_SUPPLY)
    await usdc.mint(borrower1.address, USDC_SUPPLY)
    await usdc.mint(borrower2.address, USDC_SUPPLY)

    // Deploy IRM: 5% base, 40% multiplier, 300% jump, 80% kink
    const IRMF = await ethers.getContractFactory("InterestRateModel")
    irm = await IRMF.deploy(
      parseEther("0.05"),  // 5% base
      parseEther("0.40"),  // 40% multiplier
      parseEther("3.00"),  // 300% jump
      parseEther("0.80"),  // 80% kink
    )
    await irm.waitForDeployment()

    // Deploy Oracle
    const OF = await ethers.getContractFactory("PriceOracle")
    oracle = await OF.deploy(keeper.address)
    await oracle.waitForDeployment()
    await oracle.connect(keeper).setPrice(await usdc.getAddress(), USDC_PRICE)

    // Deploy PawasaveLend (treasury acts as insurance fund in tests)
    const LF = await ethers.getContractFactory("PawasaveLend")
    lend = await LF.deploy(
      await cNGN.getAddress(),
      await irm.getAddress(),
      await oracle.getAddress(),
      treasury.address,
      treasury.address, // insurance fund = treasury in tests
    )
    await lend.waitForDeployment()

    // Add USDC as collateral — 75% LTV
    await lend.addCollateral(await usdc.getAddress(), 6, parseEther("0.75"))
    // Add cNGN as self-collateral — 60% LTV
    await lend.addCollateral(await cNGN.getAddress(), 6, parseEther("0.60"))

    console.log("✓ PawasaveLend deployed")
  })

  // ── InterestRateModel ──────────────────────────────────────────────────────
  describe("InterestRateModel", () => {
    it("returns base rate when no borrows (util=0)", async () => {
      const rate = await irm.getBorrowRate(parseEther("1000"), 0n, 0n)
      // util=0 → borrowRate = baseRatePerSecond = 0.05e18 / 31536000
      const expectedBase = parseEther("0.05") / BigInt(365 * 24 * 3600)
      expect(rate).to.equal(expectedBase)
    })

    it("returns higher rate above kink", async () => {
      const belowKink = await irm.getBorrowRate(
        parseEther("200"), parseEther("800"), 0n   // 80% util = at kink
      )
      const aboveKink = await irm.getBorrowRate(
        parseEther("100"), parseEther("900"), 0n   // 90% util
      )
      expect(aboveKink).to.be.gt(belowKink)
    })

    it("annualised borrow APR at 85% util is ~52% (above kink)", async () => {
      // cash=150, borrows=850, total=1000 → util=85%
      // normalRate = 5% + 80%*40% = 5%+32% = 37%
      // excess = 5% * 300% = 15%
      // total = 52%
      const apr = await irm.getBorrowAPR(
        parseEther("150"), parseEther("850"), 0n
      )
      expect(apr).to.be.gt(parseEther("0.45"))
      expect(apr).to.be.lt(parseEther("0.65"))
    })

    it("supply APY is lower than borrow APR (reserve factor)", async () => {
      const borrowAPR = await irm.getBorrowAPR(parseEther("150"), parseEther("850"), 0n)
      const supplyAPY = await irm.getSupplyAPY(
        parseEther("150"), parseEther("850"), 0n, parseEther("0.10")
      )
      expect(supplyAPY).to.be.lt(borrowAPR)
    })
  })

  // ── PriceOracle ────────────────────────────────────────────────────────────
  describe("PriceOracle", () => {
    it("keeper can set price", async () => {
      const price = await oracle.prices(await usdc.getAddress())
      expect(price).to.equal(USDC_PRICE)
    })

    it("non-keeper cannot set price", async () => {
      await expect(
        oracle.connect(supplier1).setPrice(await usdc.getAddress(), USDC_PRICE)
      ).to.be.revertedWith("Not authorised")
    })

    it("reverts on stale price after MAX_PRICE_AGE", async () => {
      await time.increase(3601) // > 1 hour
      await expect(
        oracle.getPrice(await usdc.getAddress())
      ).to.be.revertedWith("Price stale")
      // Refresh
      await oracle.connect(keeper).setPrice(await usdc.getAddress(), USDC_PRICE)
    })

    it("collateralToCngn converts correctly", async () => {
      // 100 USDC (6 dec) at 1650 cNGN/USDC = 165,000 cNGN
      const val = await oracle.collateralToCngn(
        await usdc.getAddress(),
        parseUnits("100", 6),
        6,
      )
      expect(val).to.equal(parseUnits("165000", 6))
    })
  })

  // ── Supply ─────────────────────────────────────────────────────────────────
  describe("Supply", () => {
    it("supplier can deposit cNGN and receive psNGN shares", async () => {
      await cNGN.connect(supplier1).approve(await lend.getAddress(), SUPPLY_AMOUNT)
      await expect(lend.connect(supplier1).supply(SUPPLY_AMOUNT))
        .to.emit(lend, "Supplied")

      const shares = await lend.balanceOf(supplier1.address)
      expect(shares).to.be.gt(0n)
    })

    it("second supplier gets correct proportional shares", async () => {
      await cNGN.connect(supplier2).approve(await lend.getAddress(), SUPPLY_AMOUNT)
      await lend.connect(supplier2).supply(SUPPLY_AMOUNT)

      const s1 = await lend.balanceOf(supplier1.address)
      const s2 = await lend.balanceOf(supplier2.address)
      expect(s1).to.equal(s2) // equal deposits → equal shares
    })

    it("rejects zero supply", async () => {
      await expect(lend.connect(supplier1).supply(0n))
        .to.be.revertedWith("Zero amount")
    })
  })

  // ── Collateral ─────────────────────────────────────────────────────────────
  describe("Collateral", () => {
    it("borrower can deposit USDC collateral", async () => {
      await usdc.connect(borrower1).approve(await lend.getAddress(), COLLATERAL)
      await expect(lend.connect(borrower1).depositCollateral(await usdc.getAddress(), COLLATERAL))
        .to.emit(lend, "CollateralDeposited")

      const bal = await lend.collateralBalance(borrower1.address, await usdc.getAddress())
      expect(bal).to.equal(COLLATERAL)
    })

    it("rejects unaccepted collateral token", async () => {
      // Deploy a random ERC20 that was never added as collateral
      const RandERC20 = await ethers.getContractFactory("MockERC20")
      const rand = await RandERC20.deploy("Random", "RND", 18)
      await rand.waitForDeployment()
      await expect(
        lend.connect(borrower1).depositCollateral(await rand.getAddress(), 1000n)
      ).to.be.revertedWith("Collateral not accepted")
    })

    it("borrower collateral value is correct", async () => {
      // 100 USDC = 165,000 cNGN at 1650 rate
      const value = await lend.totalCollateralValue(borrower1.address)
      expect(value).to.equal(parseUnits("165000", 6))
    })

    it("borrow limit is 75% of collateral value", async () => {
      const limit = await lend.borrowLimit(borrower1.address)
      // 165,000 * 0.75 = 123,750
      expect(limit).to.equal(parseUnits("123750", 6))
    })
  })

  // ── Borrow ─────────────────────────────────────────────────────────────────
  describe("Borrow", () => {
    it("borrower can borrow up to limit", async () => {
      const cngnBefore = await cNGN.balanceOf(borrower1.address)
      await expect(lend.connect(borrower1).borrow(BORROW_AMOUNT))
        .to.emit(lend, "Borrowed")

      // Borrower receives proceeds minus origination fee (0.5%)
      const fee = (BORROW_AMOUNT * 5n) / 1000n
      const cngnAfter = await cNGN.balanceOf(borrower1.address)
      expect(cngnAfter - cngnBefore).to.equal(BORROW_AMOUNT - fee)
    })

    it("borrow updates totalBorrows", async () => {
      const tb = await lend.totalBorrows()
      expect(tb).to.be.gte(BORROW_AMOUNT)
    })

    it("rejects borrow that breaches collateral factor", async () => {
      // Already borrowed 100k, limit is 123,750 — try 30k more
      await expect(
        lend.connect(borrower1).borrow(parseUnits("30000", 6))
      ).to.be.revertedWith("Insufficient collateral")
    })

    it("position is healthy after valid borrow", async () => {
      expect(await lend.isHealthy(borrower1.address)).to.be.true
    })
  })

  // ── Interest accrual ───────────────────────────────────────────────────────
  describe("Interest Accrual", () => {
    it("borrowIndex increases over time", async () => {
      const indexBefore = await lend.borrowIndex()
      await time.increase(30 * 24 * 3600) // 30 days
      await lend.accrueInterest()
      const indexAfter = await lend.borrowIndex()
      expect(indexAfter).to.be.gt(indexBefore)
    })

    it("borrower debt increases after time passes", async () => {
      const debt = await lend.borrowBalanceCurrent(borrower1.address)
      expect(debt).to.be.gt(BORROW_AMOUNT)
    })

    it("reserves accrue to protocol", async () => {
      const reserves = await lend.totalReserves()
      expect(reserves).to.be.gt(0n)
    })

    it("psNGN exchange rate increases (suppliers earn yield)", async () => {
      const rate = await lend.exchangeRate()
      // After 30 days of borrowing, rate should be > 1 cNGN per share
      expect(rate).to.be.gt(parseUnits("1", 6))
    })
  })

  // ── Repay ──────────────────────────────────────────────────────────────────
  describe("Repay", () => {
    it("borrower can partially repay", async () => {
      const repayAmount = parseUnits("50000", 6)
      const debtBefore  = await lend.borrowBalanceCurrent(borrower1.address)

      await cNGN.connect(borrower1).approve(await lend.getAddress(), repayAmount)
      await expect(lend.connect(borrower1).repay(borrower1.address, repayAmount))
        .to.emit(lend, "Repaid")

      const debtAfter = await lend.borrowBalanceCurrent(borrower1.address)
      expect(debtAfter).to.be.lt(debtBefore)
    })

    it("third party can repay on behalf of borrower", async () => {
      const repayAmount = parseUnits("10000", 6)
      await cNGN.connect(supplier1).approve(await lend.getAddress(), repayAmount)
      // supplier1 has cNGN, repays borrower1's debt
      await cNGN.mint(supplier1.address, repayAmount)
      await expect(
        lend.connect(supplier1).repay(borrower1.address, repayAmount)
      ).to.not.be.reverted
    })

    it("full repayment clears debt", async () => {
      // Mint extra buffer to cover dust interest that accrues in the same block
      const debt = await lend.borrowBalanceCurrent(borrower1.address)
      const buffer = debt / 1000n + 1000n
      await cNGN.mint(borrower1.address, buffer)
      await cNGN.connect(borrower1).approve(await lend.getAddress(), debt + buffer)
      // Use max uint to repay exactly what's owed including last-second interest
      await lend.connect(borrower1).repay(borrower1.address, 2n ** 256n - 1n)
      expect(await lend.borrowBalanceCurrent(borrower1.address)).to.equal(0n)
    })
  })

  // ── Collateral Withdrawal ──────────────────────────────────────────────────
  describe("Collateral Withdrawal", () => {
    it("borrower can withdraw collateral after full repayment", async () => {
      const bal = await lend.collateralBalance(borrower1.address, await usdc.getAddress())
      await expect(
        lend.connect(borrower1).withdrawCollateral(await usdc.getAddress(), bal)
      ).to.not.be.reverted
    })
  })

  // ── Liquidation ────────────────────────────────────────────────────────────
  describe("Liquidation", () => {
    before(async () => {
      // Refresh oracle price (stale after earlier time.increase calls)
      await oracle.connect(keeper).setPrice(await usdc.getAddress(), USDC_PRICE)

      // Set up borrower2 with a position
      await usdc.connect(borrower2).approve(await lend.getAddress(), COLLATERAL)
      await lend.connect(borrower2).depositCollateral(await usdc.getAddress(), COLLATERAL)
      // Borrow at ~75% LTV (just under limit)
      const limit = await lend.borrowLimit(borrower2.address)
      const borrowAmt = (limit * 95n) / 100n
      await lend.connect(borrower2).borrow(borrowAmt)
    })

    it("healthy position cannot be liquidated", async () => {
      await expect(
        lend.connect(liquidator).liquidate(
          borrower2.address,
          parseUnits("1000", 6),
          await usdc.getAddress()
        )
      ).to.be.revertedWith("Position is healthy")
    })

    it("underwater position can be liquidated", async () => {
      // Drop USDC price by 30% to make position underwater
      const newPrice = (USDC_PRICE * 70n) / 100n
      await oracle.connect(keeper).setPrice(await usdc.getAddress(), newPrice)

      expect(await lend.isHealthy(borrower2.address)).to.be.false

      const debt = await lend.borrowBalanceCurrent(borrower2.address)
      const maxRepay = (debt * 50n) / 100n // close factor 50%

      await cNGN.connect(liquidator).approve(await lend.getAddress(), maxRepay)
      await expect(
        lend.connect(liquidator).liquidate(
          borrower2.address,
          maxRepay,
          await usdc.getAddress()
        )
      ).to.emit(lend, "Liquidated")

      // Restore price
      await oracle.connect(keeper).setPrice(await usdc.getAddress(), USDC_PRICE)
    })

    it("liquidator cannot self-liquidate", async () => {
      await expect(
        lend.connect(borrower2).liquidate(
          borrower2.address,
          1000n,
          await usdc.getAddress()
        )
      ).to.be.revertedWith("Cannot self-liquidate")
    })
  })

  // ── Withdraw supply ────────────────────────────────────────────────────────
  describe("Withdraw Supply", () => {
    it("supplier can withdraw cNGN for psNGN shares", async () => {
      const shares = await lend.balanceOf(supplier2.address)
      const cngnBefore = await cNGN.balanceOf(supplier2.address)

      await expect(lend.connect(supplier2).withdraw(shares))
        .to.emit(lend, "Withdrawn")

      const cngnAfter = await cNGN.balanceOf(supplier2.address)
      // Should get back more than deposited due to interest
      expect(cngnAfter - cngnBefore).to.be.gte(SUPPLY_AMOUNT)
    })

    it("rejects zero share withdrawal", async () => {
      await expect(lend.connect(supplier1).withdraw(0n))
        .to.be.revertedWith("Zero shares")
    })
  })

  // ── Admin ──────────────────────────────────────────────────────────────────
  describe("Admin", () => {
    it("owner can collect reserves", async () => {
      const reservesBefore = await lend.totalReserves()
      if (reservesBefore > 0n) {
        const treasuryBefore = await cNGN.balanceOf(treasury.address)
        await lend.collectReserves()
        const treasuryAfter = await cNGN.balanceOf(treasury.address)
        expect(treasuryAfter).to.be.gt(treasuryBefore)
      }
    })

    it("owner can update reserve factor (max 30%)", async () => {
      await lend.setReserveFactor(parseEther("0.15"))
      expect(await lend.reserveFactorMantissa()).to.equal(parseEther("0.15"))
      await lend.setReserveFactor(parseEther("0.10")) // restore
    })

    it("rejects reserve factor above 30%", async () => {
      await expect(lend.setReserveFactor(parseEther("0.40")))
        .to.be.revertedWith("Max 30%")
    })

    it("owner can pause and unpause pool", async () => {
      await lend.pausePool()
      expect(await lend.paused()).to.be.true

      await cNGN.connect(supplier1).approve(await lend.getAddress(), 1000n)
      await expect(lend.connect(supplier1).supply(1000n))
        .to.be.revertedWith("Pausable: paused")

      await lend.unpausePool()
      expect(await lend.paused()).to.be.false
    })

    it("non-owner cannot change parameters", async () => {
      await expect(lend.connect(supplier1).setReserveFactor(parseEther("0.20")))
        .to.be.revertedWith("Ownable: caller is not the owner")
    })
  })

  // ── APY display ────────────────────────────────────────────────────────────
  describe("APY display", () => {
    it("reports current borrow APR", async () => {
      const apr = await lend.currentBorrowAPR()
      expect(apr).to.be.gt(0n)
    })

    it("reports current supply APY", async () => {
      const apy = await lend.currentSupplyAPY()
      expect(apy).to.be.gt(0n)
    })
  })
})
