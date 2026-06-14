import { expect } from "chai";
import { ethers } from "hardhat";

// B2B uncollateralised credit lines: allowlist, limits, per-partner APR,
// simple-interest accrual, managed-custody draw, repay, write-off, pause.
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
    // unknown partner cannot draw
    await expect(
      cl.connect(partner).draw(partner.address, u6(100), settle.address)
    ).to.be.revertedWith("Partner inactive");

    await cl.addPartner(partner.address, u6(500_000), ethers.parseEther("0.18"));
    await expect(cl.connect(partner).draw(partner.address, u6(100_000), settle.address))
      .to.emit(cl, "Drawn");
  });

  it("enforces the credit limit (principal + interest)", async () => {
    const { cl, partner, settle } = await setup();
    await cl.addPartner(partner.address, u6(100_000), ethers.parseEther("0.10"));
    await cl.connect(partner).draw(partner.address, u6(100_000), settle.address);
    await expect(
      cl.connect(partner).draw(partner.address, u6(1), settle.address)
    ).to.be.revertedWith("Exceeds credit limit");
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

  it("accrues simple interest into the debt over time", async () => {
    const { cl, partner, settle } = await setup();
    await cl.addPartner(partner.address, u6(1_000_000), ethers.parseEther("0.20")); // 20% APR
    await cl.connect(partner).draw(partner.address, u6(100_000), settle.address);

    await ethers.provider.send("evm_increaseTime", [YEAR]);
    await ethers.provider.send("evm_mine", []);

    // ~20% of 100k = ~20k interest after one year
    const debt = await cl.currentDebt(partner.address);
    expect(debt).to.be.closeTo(u6(120_000), u6(50));
  });

  it("repay reduces debt and overpay is clamped", async () => {
    const { cl, partner, settle, cngn, other } = await setup();
    await cl.addPartner(partner.address, u6(500_000), ethers.parseEther("0.10"));
    await cl.connect(partner).draw(partner.address, u6(100_000), settle.address);

    // anyone can repay on the partner's behalf
    await cngn.mint(other.address, u6(200_000));
    await cngn.connect(other).approve(await cl.getAddress(), u6(200_000));

    const before = await cngn.balanceOf(other.address);
    await cl.connect(other).repay(partner.address, u6(500_000)); // overpay → clamped to debt
    const spent = before - (await cngn.balanceOf(other.address));

    expect((await cl.partners(partner.address)).principal).to.equal(0n);
    // only ~the outstanding debt was pulled, not the full 500k
    expect(spent).to.be.closeTo(u6(100_000), u6(50));
  });

  it("suspend freezes new draws but still allows repay", async () => {
    const { cl, partner, settle, cngn } = await setup();
    await cl.addPartner(partner.address, u6(500_000), ethers.parseEther("0.10"));
    await cl.connect(partner).draw(partner.address, u6(100_000), settle.address);

    await cl.suspendPartner(partner.address);
    await expect(
      cl.connect(partner).draw(partner.address, u6(1), settle.address)
    ).to.be.revertedWith("Partner inactive");

    // repay still works while suspended (overpay clamps, clearing accrued interest too)
    await cngn.mint(partner.address, u6(101_000));
    await cngn.connect(partner).approve(await cl.getAddress(), u6(101_000));
    await cl.connect(partner).repay(partner.address, u6(101_000));
    expect((await cl.partners(partner.address)).principal).to.equal(0n);

    // reactivate restores draws
    await cl.reactivatePartner(partner.address);
    await expect(cl.connect(partner).draw(partner.address, u6(10), settle.address))
      .to.emit(cl, "Drawn");
  });

  it("owner can write off uncollectible debt", async () => {
    const { cl, partner, settle } = await setup();
    await cl.addPartner(partner.address, u6(500_000), ethers.parseEther("0.10"));
    await cl.connect(partner).draw(partner.address, u6(100_000), settle.address);

    await cl.writeOff(partner.address, u6(40_000));
    // ~60k remains (a few seconds of interest folded in before the write-off)
    expect((await cl.partners(partner.address)).principal).to.be.closeTo(u6(60_000), u6(50));
    await expect(cl.writeOff(partner.address, u6(999_999))).to.be.revertedWith("Bad amount");
  });

  it("owner can only withdraw idle liquidity, not drawn principal", async () => {
    const { cl, owner, partner, settle } = await setup();
    await cl.addPartner(partner.address, u6(900_000), ethers.parseEther("0.10"));
    await cl.connect(partner).draw(partner.address, u6(900_000), settle.address);

    // 100k idle remains
    expect(await cl.availableLiquidity()).to.equal(u6(100_000));
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
    // principal should now reflect ~120k folded in at the old 20% rate
    expect((await cl.partners(partner.address)).principal).to.be.closeTo(u6(120_000), u6(100));
    expect((await cl.partners(partner.address)).ratePerYear).to.equal(ethers.parseEther("0.30"));
  });
});