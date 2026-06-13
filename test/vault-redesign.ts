import { expect } from "chai";
import { ethers } from "hardhat";

// Verifies the PawasaveAutoVault redesign (audit Batch 7b).
const u6 = (n: number) => BigInt(n) * 1_000_000n;

async function deploy() {
  const [owner, alice, bob, feeRecipient] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20");
  const cngn = await Mock.deploy("cNGN", "cNGN", 6);
  const other = await Mock.deploy("OTHER", "OTH", 6);

  const Strat = await ethers.getContractFactory("MockStrategy");
  const strat = await Strat.deploy(await cngn.getAddress());

  const Vault = await ethers.getContractFactory("PawasaveAutoVault");
  const vault = await Vault.deploy(
    await cngn.getAddress(), await strat.getAddress(), ethers.ZeroAddress, feeRecipient.address,
  );

  // fund + approve
  for (const u of [alice, bob, owner]) {
    await cngn.mint(u.address, u6(10000));
    await cngn.connect(u).approve(await vault.getAddress(), ethers.MaxUint256);
  }
  return { owner, alice, bob, feeRecipient, cngn, other, strat, vault };
}

describe("Vault redesign (Batch 7b)", () => {
  it("SC-03: direct donation to the strategy does NOT inflate totalAssets", async () => {
    const { vault, cngn, strat, alice } = await deploy();
    await vault.connect(alice).depositFlexible(u6(1000), alice.address);
    expect(await vault.totalAssets()).to.equal(u6(1000));
    // attacker donates straight to the strategy address
    await cngn.mint(alice.address, u6(5000));
    await cngn.connect(alice).transfer(await strat.getAddress(), u6(5000));
    // internal accounting ignores the donation
    expect(await vault.totalAssets()).to.equal(u6(1000));
  });

  it("SC-01/02: flexible stays withdrawable while a fixed lock holds; O(1) check", async () => {
    const { vault, alice } = await deploy();
    await vault.connect(alice).depositFlexible(u6(100), alice.address);
    const flexShares = await vault.balanceOf(alice.address);
    await vault.connect(alice).depositFixed(u6(100), alice.address, 30);
    const lockedShares = await vault.lockedShares(alice.address);
    expect(lockedShares).to.be.gt(0n);
    expect(await vault.maxWithdrawableShares(alice.address)).to.equal(flexShares);

    // cannot dip into the locked portion
    await expect(vault.connect(alice).redeem(flexShares + 1n, alice.address, alice.address))
      .to.be.revertedWith("Funds still locked");
    // but the flexible portion redeems fine
    await vault.connect(alice).redeem(flexShares, alice.address, alice.address);
  });

  it("SC-01/02: releaseMatured frees a lock after maturity", async () => {
    const { vault, alice } = await deploy();
    await vault.connect(alice).depositFixed(u6(100), alice.address, 30);
    const shares = await vault.balanceOf(alice.address);
    await expect(vault.connect(alice).redeem(shares, alice.address, alice.address))
      .to.be.revertedWith("Funds still locked");

    await ethers.provider.send("evm_increaseTime", [31 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(alice).releaseMatured();
    expect(await vault.lockedShares(alice.address)).to.equal(0n);
    await vault.connect(alice).redeem(shares, alice.address, alice.address); // now ok
  });

  it("anti-grief: depositFixed must name the caller as receiver", async () => {
    const { vault, alice, bob } = await deploy();
    await expect(vault.connect(alice).depositFixed(u6(100), bob.address, 30))
      .to.be.revertedWith("Fixed: receiver must be caller");
  });

  it("SC-05/07: strategy changes are interface-checked and timelocked", async () => {
    const { vault, owner, cngn, other } = await deploy();
    const Strat = await ethers.getContractFactory("MockStrategy");
    const good = await Strat.deploy(await cngn.getAddress());
    const wrongAsset = await Strat.deploy(await other.getAddress());

    await expect(vault.connect(owner).proposePrimaryStrategy(await wrongAsset.getAddress()))
      .to.be.revertedWith("Strategy asset mismatch");

    await vault.connect(owner).proposePrimaryStrategy(await good.getAddress());
    await expect(vault.connect(owner).executePrimaryStrategy()).to.be.revertedWith("Timelock active");

    await ethers.provider.send("evm_increaseTime", [48 * 3600 + 1]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(owner).executePrimaryStrategy();
    expect(await vault.primaryStrategy()).to.equal(await good.getAddress());
  });

  it("SC-04/09: harvest takes the platform fee and is a clean no-op at zero", async () => {
    const { vault, owner, strat, cngn, feeRecipient, alice } = await deploy();
    await vault.connect(alice).depositFlexible(u6(1000), alice.address);

    // no yield yet → clean no-op
    expect(await vault.connect(owner).harvestYield.staticCall()).to.equal(0n);

    // seed 50 cNGN of yield into the strategy
    await cngn.connect(owner).approve(await strat.getAddress(), u6(50));
    await strat.connect(owner).addYield(u6(50));

    await vault.connect(owner).harvestYield();
    expect(await cngn.balanceOf(feeRecipient.address)).to.equal(u6(50) * 600n / 10000n); // 3 cNGN
    expect(await vault.totalAssets()).to.equal(u6(1000) + (u6(50) - u6(50) * 600n / 10000n)); // 1047
  });

  it("SC-06: emergencyWithdraw pauses and pulls funds back to the vault", async () => {
    const { vault, owner, strat, cngn, alice } = await deploy();
    await vault.connect(alice).depositFlexible(u6(1000), alice.address);
    expect(await cngn.balanceOf(await strat.getAddress())).to.equal(u6(1000));
    await vault.connect(owner).emergencyWithdraw();
    expect(await vault.paused()).to.equal(true);
    expect(await cngn.balanceOf(await vault.getAddress())).to.equal(u6(1000));
  });
});