import { expect } from "chai";
import { ethers } from "hardhat";

// Loan maturity overlay: tenor, due date, 4-day grace, overdue liquidation.
const u6 = (n: number) => BigInt(n) * 1_000_000n;
const DAY = 86400;

async function setup() {
  const [owner, supplier, borrower, liquidator, treasury, keeper] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20");
  const cngn = await Mock.deploy("cNGN", "cNGN", 6);
  const usdc = await Mock.deploy("USDC", "USDC", 6);
  const IRM = await ethers.getContractFactory("InterestRateModel");
  const irm = await IRM.deploy(ethers.parseEther("0.05"), ethers.parseEther("0.40"), ethers.parseEther("3.0"), ethers.parseEther("0.80"));
  const Oracle = await ethers.getContractFactory("PriceOracle");
  const oracle = await Oracle.deploy(keeper.address);
  const Lend = await ethers.getContractFactory("PawasaveLend");
  const lend = await Lend.deploy(await cngn.getAddress(), await irm.getAddress(), await oracle.getAddress(), treasury.address, treasury.address);
  await lend.addCollateral(await usdc.getAddress(), 6, ethers.parseEther("0.75"));
  await oracle.connect(keeper).setPrice(await usdc.getAddress(), u6(1));

  // supplier funds the pool
  await cngn.mint(supplier.address, u6(1000));
  await cngn.connect(supplier).approve(await lend.getAddress(), u6(1000));
  await lend.connect(supplier).supply(u6(1000));
  // borrower posts collateral
  await usdc.mint(borrower.address, u6(1000));
  await usdc.connect(borrower).approve(await lend.getAddress(), u6(1000));
  await lend.connect(borrower).depositCollateral(await usdc.getAddress(), u6(1000));
  return { owner, supplier, borrower, liquidator, keeper, cngn, usdc, lend, oracle };
}

describe("Loan tenor + overdue liquidation", () => {
  it("default borrow sets a 90-day due date", async () => {
    const { lend, borrower } = await setup();
    await lend.connect(borrower)["borrow(uint256)"](u6(100));
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const due = Number(await lend.loanDueDate(borrower.address));
    expect(due).to.be.closeTo(now + 90 * DAY, 5);
  });

  it("accepts any tenor in MIN..maxTenorDays; rejects out-of-range", async () => {
    const { lend, borrower } = await setup();
    // Below the 7-day minimum and above the 365-day default max are rejected.
    await expect(lend.connect(borrower)["borrow(uint256,uint256)"](u6(10), 3)).to.be.revertedWith("Invalid tenor");
    await expect(lend.connect(borrower)["borrow(uint256,uint256)"](u6(10), 400)).to.be.revertedWith("Invalid tenor");
    // A non-standard in-range tenor (e.g. 180) is fine.
    await lend.connect(borrower)["borrow(uint256,uint256)"](u6(10), 180);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    expect(Number(await lend.loanDueDate(borrower.address))).to.be.closeTo(now + 180 * DAY, 5);
  });

  it("supports the longer 365-day tenor (and owner can extend the max)", async () => {
    const { lend, owner, borrower } = await setup();
    await lend.connect(borrower)["borrow(uint256,uint256)"](u6(50), 365);
    let now = (await ethers.provider.getBlock("latest"))!.timestamp;
    expect(Number(await lend.loanDueDate(borrower.address))).to.be.closeTo(now + 365 * DAY, 5);

    // Owner raises the ceiling; a fresh borrower can then take a longer term.
    await lend.connect(owner).setMaxTenor(540);
    expect(await lend.maxTenorDays()).to.equal(540n);
    await expect(lend.connect(owner).setMaxTenor(1000)).to.be.revertedWith("Tenor out of range");
  });

  it("healthy + not overdue cannot be liquidated", async () => {
    const { lend, borrower, liquidator, usdc } = await setup();
    await lend.connect(borrower)["borrow(uint256)"](u6(100));
    await expect(
      lend.connect(liquidator).liquidate(borrower.address, u6(10), await usdc.getAddress())
    ).to.be.revertedWith("Healthy and not overdue");
  });

  it("overdue loan is liquidatable even while well-collateralised", async () => {
    const { lend, borrower, liquidator, keeper, cngn, usdc, oracle } = await setup();
    await lend.connect(borrower)["borrow(uint256)"](u6(100));
    expect(await lend.isLiquidatable(borrower.address)).to.equal(false); // healthy, not due

    await ethers.provider.send("evm_increaseTime", [95 * DAY]); // past 90d + 4d grace
    await ethers.provider.send("evm_mine", []);
    // keeper refreshes the price (it would go stale over 95 days otherwise)
    await oracle.connect(keeper).setPrice(await usdc.getAddress(), u6(1));

    expect(await lend.isOverdue(borrower.address)).to.equal(true);
    expect(await lend.isLiquidatable(borrower.address)).to.equal(true);

    await cngn.mint(liquidator.address, u6(60));
    await cngn.connect(liquidator).approve(await lend.getAddress(), u6(60));
    await expect(
      lend.connect(liquidator).liquidate(borrower.address, u6(40), await usdc.getAddress())
    ).to.emit(lend, "Liquidated");
  });

  it("full repayment clears the due date", async () => {
    const { lend, borrower, cngn } = await setup();
    await lend.connect(borrower)["borrow(uint256)"](u6(100));
    expect(Number(await lend.loanDueDate(borrower.address))).to.be.gt(0);
    await cngn.mint(borrower.address, u6(5));
    await cngn.connect(borrower).approve(await lend.getAddress(), u6(200));
    await lend.connect(borrower).repay(borrower.address, ethers.MaxUint256);
    expect(await lend.loanDueDate(borrower.address)).to.equal(0n);
  });
});