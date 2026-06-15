import { expect } from "chai";
import { ethers } from "hardhat";

// Beta blast-radius caps: pool supplyCap + maxSupplyPerUser, vault depositCap.
const u6 = (n: number) => BigInt(n) * 1_000_000n;

async function lendSetup() {
  const [owner, alice, bob, treasury, keeper] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20");
  const cngn = await Mock.deploy("cNGN", "cNGN", 6);
  const IRM = await ethers.getContractFactory("InterestRateModel");
  const irm = await IRM.deploy(ethers.parseEther("0.05"), ethers.parseEther("0.40"), ethers.parseEther("3.0"), ethers.parseEther("0.80"));
  const Oracle = await ethers.getContractFactory("PriceOracle");
  const oracle = await Oracle.deploy(keeper.address);
  const Lend = await ethers.getContractFactory("PawasaveLend");
  const lend = await Lend.deploy(await cngn.getAddress(), await irm.getAddress(), await oracle.getAddress(), treasury.address, treasury.address);
  for (const u of [alice, bob]) {
    await cngn.mint(u.address, u6(1_000_000));
    await cngn.connect(u).approve(await lend.getAddress(), u6(1_000_000));
  }
  return { owner, alice, bob, cngn, lend };
}

describe("Beta caps — PawasaveLend supply", () => {
  it("supplyCap blocks supply past the total ceiling", async () => {
    const { owner, alice, bob, lend } = await lendSetup();
    await lend.connect(owner).setSupplyCap(u6(100));
    await lend.connect(alice).supply(u6(80));
    await expect(lend.connect(bob).supply(u6(30))).to.be.revertedWith("Supply cap reached");
    await lend.connect(bob).supply(u6(20)); // exactly at the cap is allowed
  });

  it("maxSupplyPerUser caps a single supplier", async () => {
    const { owner, alice, lend } = await lendSetup();
    await lend.connect(owner).setMaxSupplyPerUser(u6(50));
    await lend.connect(alice).supply(u6(50));
    await expect(lend.connect(alice).supply(u6(1))).to.be.revertedWith("Exceeds per-user supply cap");
  });

  it("caps default to off (0 = unlimited)", async () => {
    const { alice, lend } = await lendSetup();
    expect(await lend.supplyCap()).to.equal(0n);
    expect(await lend.maxSupplyPerUser()).to.equal(0n);
    await lend.connect(alice).supply(u6(500_000)); // no cap → fine
  });

  it("only owner can set caps", async () => {
    const { alice, lend } = await lendSetup();
    await expect(lend.connect(alice).setSupplyCap(u6(10))).to.be.revertedWith("Ownable: caller is not the owner");
    await expect(lend.connect(alice).setMaxSupplyPerUser(u6(10))).to.be.revertedWith("Ownable: caller is not the owner");
  });
});

async function vaultSetup() {
  const [owner, alice] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20");
  const cngn = await Mock.deploy("cNGN", "cNGN", 6);
  const Strat = await ethers.getContractFactory("MockStrategy");
  const primary = await Strat.deploy(await cngn.getAddress());
  const Vault = await ethers.getContractFactory("PawasaveAutoVault");
  const vault = await Vault.deploy(await cngn.getAddress(), await primary.getAddress(), ethers.ZeroAddress, owner.address);
  await cngn.mint(alice.address, u6(1_000_000));
  await cngn.connect(alice).approve(await vault.getAddress(), u6(1_000_000));
  return { owner, alice, cngn, vault };
}

describe("Beta caps — PawasaveAutoVault deposit", () => {
  it("depositCap blocks deposits past the ceiling (flexible path)", async () => {
    const { owner, alice, vault } = await vaultSetup();
    await vault.connect(owner).setDepositCap(u6(100));
    await vault.connect(alice).depositFlexible(u6(80), alice.address);
    await expect(vault.connect(alice).depositFlexible(u6(30), alice.address)).to.be.revertedWith("Deposit cap reached");
  });

  it("maxDeposit reflects remaining room and gates the standard deposit()", async () => {
    const { owner, alice, vault } = await vaultSetup();
    await vault.connect(owner).setDepositCap(u6(100));
    await vault.connect(alice).deposit(u6(60), alice.address);
    expect(await vault.maxDeposit(alice.address)).to.equal(u6(40));
    await expect(vault.connect(alice).deposit(u6(41), alice.address)).to.be.revertedWith("ERC4626: deposit more than max");
  });

  it("cap off by default; only owner can set it", async () => {
    const { alice, vault } = await vaultSetup();
    expect(await vault.depositCap()).to.equal(0n);
    await expect(vault.connect(alice).setDepositCap(u6(10))).to.be.revertedWith("Ownable: caller is not the owner");
  });
});