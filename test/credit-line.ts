import { expect } from "chai";
import { ethers } from "hardhat";

// B2B uncollateralised credit lines: allowlist, limits, per-partner APR,
// simple-interest accrual (principal vs interest tracked separately), managed
// custody draw, repay (interest-first), write-off, pause.
const u6 = (n: number) => BigInt(n) * 1_000_000n;
const YEAR = 365 * 86400;

async function setup() {
  const [owner, partner, other, settle] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20");
  const cngn = await Mock.deploy("cNGN", "cNGN", 6);
  const CL = await ethers.getContractFactory("PawasaveCreditLine");
  const cl = await CL.deploy(await cngn.getAddress());

  // owner funds the credit-line with 1,000,000 cNGN of liquidity
  await cngn.mint(owner.address, u6(1_000_000));
  await cngn.approve(await cl.getAddress(), u6(1_000_000));
  await cl.fund(u6(1_000_000));
  return { owner, partner, other, settle, cngn, cl };
}

describe("PawasaveCreditLine (B2B)", () => {
  it("only allowlisted, active partners can draw", async () => {
    const { cl, partner, settle } = await setup();
    await expect(
      cl.connect(partner).draw(partner.address, u6(100), settle.address)
    ).to.be.revertedWith("Partner inactive");

    await cl.addPartner(partner.address, u6(500_000), ethers.parseEther("0.18"));
    await expect(cl.connect(partner).draw(partner.address, u6(100_000), settle.address))
      .to.emit(cl, "Drawn");
  });

  it("enforces the credit limit on drawn principal", async () => {
    const { cl, partner, settle } = await setup();
    await cl.addPartner(partner.address, u6(100_000), ethers.parseEther("0.10"));
    await cl.connect(partner).draw(partner.address, u6(100_000), settle.address);
    await expect(
      cl.connect(partner).draw(partner.address, u6(1), settle.address)
    ).to.be.revertedWith("Exceeds credit limit");
  });

  it("V2-HIGH-01: accrued interest does NOT consume draw headroom", async () => {
    const { cl, partner, settle } = await setup();
    await cl.addPartner(partner.address, u6(100_000), ethers.parseEther("0.20"));
    await cl.connect(partner).draw(partner.address, u6(50_000), settle.address);

    // a year passes — debt grows past 50k via interest, but principal stays 50k
    await ethers.provider.send("evm_increaseTime", [YEAR]);
    await ethers.provider.send("evm_mine", []);
    expect(await cl.currentDebt(partner.address)).to.be.gt(u6(50_000));

    // partner can still draw the remaining 50k of PRINCIPAL headroom
    await expect(cl.connect(partner).draw(partner.address, u6(50_000), settle.address))
      .to.emit(cl, "Drawn");
    expect((await cl.partners(partner.address)).principal).to.equal(u6(100_000));
  });

  it("owner can draw on a partner's behalf (managed custody)", async () => {
    const { cl, owner, partner, settle, cngn } = await setup();
    await cl.addPartner(partner.address, u6(500_000), ethers.parseEther("0.18"));
    await cl.connect(owner).draw(partner.address, u6(200_000), settle.address);
    expect(await cngn.balanceOf(settle.address)).to.equal(u6(200_000));
    expect((await cl.partners(partner.address)).principal).to.equal(u6(200_000));
  });

  it("a stranger cannot draw on a partner's line", async () => {
    const { cl, partner, other, settle } = await setup();
    await cl.addPartner(partner.address, u6(500_000), ethers.parseEther("0.18"));
    await expect(
      cl.connect(other).draw(partner.address, u6(100), settle.address)
    ).to.be.revertedWith("Not authorised");
  });

  it("accrues simple interest into the debt over time (principal unchanged)", async () => {
    const { cl, partner, settle } = await setup();
    await cl.addPartner(partner.address, u6(1_000_000), ethers.parseEther("0.20")); // 20% APR
    await cl.connect(partner).draw(partner.address, u6(100_000), settle.address);

    await ethers.provider.send("evm_increaseTime", [YEAR]);
    await ethers.provider.send("evm_mine", []);

    expect(await cl.currentDebt(partner.address)).to.be.closeTo(u6(120_000), u6(50));
    expect((await cl.partners(partner.address)).principal).to.equal(u6(100_000));
  });

  it("repay applies interest-first, reduces debt, and overpay is clamped", async () => {
    const { cl, partner, settle, cngn, other } = await setup();
    await cl.addPartner(partner.address, u6(500_000), ethers.parseEther("0.10"));
    await cl.connect(partner).draw(partner.address, u6(100_000), settle.address);

    await cngn.mint(other.address, u6(200_000));
    await cngn.connect(other).approve(await cl.getAddress(), u6(200_000));

    const before = await cngn.balanceOf(other.address);
    await cl.connect(other).repay(partner.address, u6(500_000)); // overpay → clamped to debt
    const spent = before - (await cngn.balanceOf(other.address));

    const p = await cl.partners(partner.address);
    expect(p.principal).to.equal(0n);
    expect(p.interestAccrued).to.equal(0n);
    expect(spent).to.be.closeTo(u6(100_000), u6(50));
  });

  it("rejects dust repayments below MIN_REPAY but allows clearing a small debt", async () => {
    const { cl, partner, settle, cngn } = await setup();
    await cl.addPartner(partner.address, u6(500_000), ethers.parseEther("0.10"));
    await cl.connect(partner).draw(partner.address, u6(100_000), settle.address);
    await cngn.mint(partner.address, u6(100_000));
    await cngn.connect(partner).approve(await cl.getAddress(), u6(100_000));
    // below 1 cNGN dust repay rejected
    await expect(cl.connect(partner).repay(partner.address, 500_000n)).to.be.revertedWith("Below min repay");
    // a normal repay works
    await expect(cl.connect(partner).repay(partner.address, u6(50_000))).to.emit(cl, "Repaid");
  });

  it("suspend freezes new draws but still allows repay", async () => {
    const { cl, partner, settle, cngn } = await setup();
    await cl.addPartner(partner.address, u6(500_000), ethers.parseEther("0.10"));
    await cl.connect(partner).draw(partner.address, u6(100_000), settle.address);

    await cl.suspendPartner(partner.address);
    await expect(
      cl.connect(partner).draw(partner.address, u6(1), settle.address)
    ).to.be.revertedWith("Partner inactive");

    await cngn.mint(partner.address, u6(101_000));
    await cngn.connect(partner).approve(await cl.getAddress(), u6(101_000));
    await cl.connect(partner).repay(partner.address, u6(101_000)); // clamps to debt, clears it
    expect((await cl.partners(partner.address)).principal).to.equal(0n);

    await cl.reactivatePartner(partner.address);
    await expect(cl.connect(partner).draw(partner.address, u6(10), settle.address))
      .to.emit(cl, "Drawn");
  });

  it("owner can write off uncollectible debt (with reason) + totalWrittenOff", async () => {
    const { cl, partner, settle } = await setup();
    await cl.addPartner(partner.address, u6(500_000), ethers.parseEther("0.10"));
    await cl.connect(partner).draw(partner.address, u6(100_000), settle.address);

    await cl.writeOff(partner.address, u6(40_000), "partner insolvent");
    // ~60k principal remains (a few seconds of interest is written off first)
    expect((await cl.partners(partner.address)).principal).to.be.closeTo(u6(60_000), u6(50));
    expect(await cl.totalWrittenOff()).to.equal(u6(40_000));
    await expect(cl.writeOff(partner.address, u6(999_999), "x")).to.be.revertedWith("Bad amount");
  });

  it("owner can only withdraw idle liquidity, not drawn principal", async () => {
    const { cl, owner, partner, settle } = await setup();
    await cl.addPartner(partner.address, u6(900_000), ethers.parseEther("0.10"));
    await cl.connect(partner).draw(partner.address, u6(900_000), settle.address);

    expect(await cl.idleLiquidity()).to.equal(u6(100_000));
    await expect(
      cl.withdrawLiquidity(u6(150_000), owner.address)
    ).to.be.revertedWith("Exceeds idle liquidity");
    await expect(cl.withdrawLiquidity(u6(100_000), owner.address)).to.emit(cl, "LiquidityWithdrawn");
  });

  it("pause halts draws and repays", async () => {
    const { cl, partner, settle } = await setup();
    await cl.addPartner(partner.address, u6(500_000), ethers.parseEther("0.10"));
    await cl.pause();
    await expect(
      cl.connect(partner).draw(partner.address, u6(100), settle.address)
    ).to.be.revertedWith("Pausable: paused");
    await expect(
      cl.connect(partner).repay(partner.address, u6(100))
    ).to.be.revertedWith("Pausable: paused");
  });

  it("re-pricing accrues at the old rate first", async () => {
    const { cl, partner, settle } = await setup();
    await cl.addPartner(partner.address, u6(1_000_000), ethers.parseEther("0.20"));
    await cl.connect(partner).draw(partner.address, u6(100_000), settle.address);

    await ethers.provider.send("evm_increaseTime", [YEAR]);
    await cl.setPartnerRate(partner.address, ethers.parseEther("0.30")); // accrues 20% first
    expect((await cl.partners(partner.address)).interestAccrued).to.be.closeTo(u6(20_000), u6(100));
    expect((await cl.partners(partner.address)).ratePerYear).to.equal(ethers.parseEther("0.30"));
  });
});