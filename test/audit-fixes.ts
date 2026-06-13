import { expect } from "chai";
import { ethers } from "hardhat";

// Verifies the contained smart-contract audit fixes (Batch 7a).
const u6 = (n: number) => BigInt(n) * 1_000_000n; // cNGN/USDC have 6 decimals

async function deploy() {
  const [owner, supplier, borrower, treasury, keeper] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockERC20");
  const cngn = await Mock.deploy("cNGN", "cNGN", 6);
  const usdc = await Mock.deploy("USDC", "USDC", 6);

  const IRM = await ethers.getContractFactory("InterestRateModel");
  const irm = await IRM.deploy(
    ethers.parseEther("0.05"), ethers.parseEther("0.40"),
    ethers.parseEther("3.0"), ethers.parseEther("0.80"),
  );

  const Oracle = await ethers.getContractFactory("PriceOracle");
  const oracle = await Oracle.deploy(keeper.address);

  const Lend = await ethers.getContractFactory("PawasaveLend");
  const lend = await Lend.deploy(
    await cngn.getAddress(), await irm.getAddress(), await oracle.getAddress(),
    treasury.address, treasury.address,
  );

  await lend.addCollateral(await usdc.getAddress(), 6, ethers.parseEther("0.75"));
  // price = cNGN per 1e18 collateral; 1 whole USDC = 1 cNGN → 1e6
  await oracle.connect(keeper).setPrice(await usdc.getAddress(), u6(1));

  return { owner, supplier, borrower, treasury, keeper, cngn, usdc, irm, oracle, lend };
}

async function seedAndCollateralise(ctx: Awaited<ReturnType<typeof deploy>>) {
  const { lend, cngn, usdc, supplier, borrower } = ctx;
  await cngn.mint(supplier.address, u6(1000));
  await cngn.connect(supplier).approve(await lend.getAddress(), u6(1000));
  await lend.connect(supplier).supply(u6(1000));
  await usdc.mint(borrower.address, u6(1000));
  await usdc.connect(borrower).approve(await lend.getAddress(), u6(1000));
  await lend.connect(borrower).depositCollateral(await usdc.getAddress(), u6(1000));
}

describe("Audit fixes (Batch 7a)", () => {
  it("SC-20: oracle rejects large deviations, owner can force-override", async () => {
    const { oracle, keeper, owner, usdc } = await deploy();
    const t = await usdc.getAddress();
    await oracle.connect(keeper).setPrice(t, 1_200_000n); // +20% from 1e6 — ok
    await expect(oracle.connect(keeper).setPrice(t, 2_000_000n))
      .to.be.revertedWith("Price deviation too large");
    await oracle.connect(owner).forceSetPrice(t, 2_000_000n); // owner override
    expect(await oracle.prices(t)).to.equal(2_000_000n);
  });

  it("SC-13: oracle reverts on a stale price (liquidation reads getPrice)", async () => {
    const { oracle, usdc } = await deploy();
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await expect(oracle.getPrice(await usdc.getAddress())).to.be.revertedWith("Price stale");
  });

  it("SC-11: borrow leaves totalPoolAssets invariant; fee accrues to reserves", async () => {
    const ctx = await deploy();
    await seedAndCollateralise(ctx);
    const { lend, cngn, borrower } = ctx;

    const before = await lend.totalPoolAssets();
    await lend.connect(borrower).borrow(u6(100));
    expect(await lend.totalPoolAssets()).to.equal(before); // no leak / no double-count

    // repay full (mint a touch extra to cover the 0.5% origination fee)
    await cngn.mint(borrower.address, u6(1));
    await cngn.connect(borrower).approve(await lend.getAddress(), u6(200));
    await lend.connect(borrower).repay(borrower.address, ethers.MaxUint256);

    expect(await lend.totalReserves()).to.equal(u6(100) * 5n / 1000n); // 0.5 cNGN
    expect(await lend.totalPoolAssets()).to.equal(before);
  });

  it("SC-17: enforces per-user borrow cap", async () => {
    const ctx = await deploy();
    await seedAndCollateralise(ctx);
    const { lend, owner, borrower } = ctx;
    await lend.connect(owner).setMaxBorrowPerUser(u6(50));
    await expect(lend.connect(borrower).borrow(u6(100)))
      .to.be.revertedWith("Exceeds per-user borrow cap");
    await lend.connect(borrower).borrow(u6(40)); // under cap — ok
  });

  it("SC-25: interest-rate model is updatable", async () => {
    const { lend, owner } = await deploy();
    const IRM = await ethers.getContractFactory("InterestRateModel");
    const irm2 = await IRM.deploy(
      ethers.parseEther("0.10"), ethers.parseEther("0.40"),
      ethers.parseEther("3.0"), ethers.parseEther("0.80"),
    );
    await lend.connect(owner).setInterestRateModel(await irm2.getAddress());
    expect(await lend.irm()).to.equal(await irm2.getAddress());
  });

  it("SC-19: removeCollateral trims the collateral list", async () => {
    const { lend, owner, usdc } = await deploy();
    await lend.connect(owner).removeCollateral(await usdc.getAddress());
    await expect(lend.collateralList(0)).to.be.reverted; // array now empty
  });
});