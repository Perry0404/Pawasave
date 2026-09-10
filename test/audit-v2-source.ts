import { expect } from "chai";
import { ethers } from "hardhat";

// Regression tests for the audit-v2 contract source batch bundled for the v3
// redeploy: V2-MED-01 (vault withdraw passthrough), the oracle price floor, and
// the lend-strategy pause (V2-SC-02/04).
const u6 = (n: number) => BigInt(n) * 1_000_000n;

describe("Audit v2 — source batch (v3 bundle)", () => {
  describe("V2-MED-01: vault _withdraw uses the strategy's actual returned amount", () => {
    async function deploy() {
      const [owner, alice, feeRecipient] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const cngn = await Mock.deploy("cNGN", "cNGN", 6);
      const Strat = await ethers.getContractFactory("MockStrategy");
      const strat = await Strat.deploy(await cngn.getAddress());
      const Vault = await ethers.getContractFactory("PawasaveAutoVault");
      const vault = await Vault.deploy(
        await cngn.getAddress(), await strat.getAddress(), ethers.ZeroAddress, feeRecipient.address,
      );
      await cngn.mint(alice.address, u6(10000));
      await cngn.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
      return { owner, alice, cngn, strat, vault };
    }

    it("normal withdrawal pulls from the strategy and succeeds", async () => {
      const { vault, alice, cngn } = await deploy();
      await vault.connect(alice).depositFlexible(u6(1000), alice.address);
      const shares = await vault.balanceOf(alice.address);
      await vault.connect(alice).redeem(shares, alice.address, alice.address);
      expect(await cngn.balanceOf(alice.address)).to.equal(u6(10000));
    });

    it("reverts cleanly when the strategy can't cover the redemption (no silent shortfall)", async () => {
      const { vault, alice, strat, owner } = await deploy();
      await vault.connect(alice).depositFlexible(u6(1000), alice.address);
      const shares = await vault.balanceOf(alice.address);
      // Strategy loses its funds → withdraw() returns less than requested.
      await strat.connect(owner).drain(owner.address);
      await expect(vault.connect(alice).redeem(shares, alice.address, alice.address))
        .to.be.revertedWith("Strategy withdraw shortfall");
    });
  });

  describe("Oracle price floor", () => {
    async function deploy() {
      const [owner, keeper] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const token = await Mock.deploy("USDC", "USDC", 6);
      const Oracle = await ethers.getContractFactory("PriceOracle");
      const oracle = await Oracle.deploy(keeper.address);
      return { owner, keeper, oracle, token: await token.getAddress() };
    }

    it("rejects a price below the configured floor on first set", async () => {
      const { owner, keeper, oracle, token } = await deploy();
      await oracle.connect(owner).setMinPrice(token, u6(1000)); // floor 1000 cNGN
      await expect(oracle.connect(keeper).setPrice(token, u6(1))) // glitch near-zero
        .to.be.revertedWith("Price below floor");
      await oracle.connect(keeper).setPrice(token, u6(1650)); // above floor → ok
      expect(await oracle.prices(token)).to.equal(u6(1650));
    });

    it("floor also applies to the owner forceSetPrice escape hatch", async () => {
      const { owner, keeper, oracle, token } = await deploy();
      await oracle.connect(keeper).setPrice(token, u6(1650));
      await oracle.connect(owner).setMinPrice(token, u6(1000));
      await expect(oracle.connect(owner).forceSetPrice(token, u6(5)))
        .to.be.revertedWith("Price below floor");
    });

    it("cannot set a floor above the current price", async () => {
      const { owner, keeper, oracle, token } = await deploy();
      await oracle.connect(keeper).setPrice(token, u6(1650));
      await expect(oracle.connect(owner).setMinPrice(token, u6(2000)))
        .to.be.revertedWith("Floor above price");
    });
  });

  describe("V2-SC-02/04: lend strategy pause", () => {
    async function deploy() {
      const [owner, vault] = await ethers.getSigners();
      const Mock = await ethers.getContractFactory("MockERC20");
      const cngn = await Mock.deploy("cNGN", "cNGN", 6);
      // _lend just needs to be non-zero; the pause check fires before any lend call.
      const Strat = await ethers.getContractFactory("PawasaveLendStrategy");
      const strat = await Strat.deploy(await cngn.getAddress(), owner.address);
      await strat.connect(owner).setVault(vault.address);
      return { owner, vault, cngn, strat };
    }

    it("blocks new deposits while paused", async () => {
      const { owner, vault, strat } = await deploy();
      await strat.connect(owner).setPaused(true);
      await expect(strat.connect(vault).deposit(u6(100)))
        .to.be.revertedWith("Strategy paused");
      await strat.connect(owner).setPaused(false);
      expect(await strat.paused()).to.equal(false);
    });

    it("only the owner can pause", async () => {
      const { vault, strat } = await deploy();
      await expect(strat.connect(vault).setPaused(true))
        .to.be.revertedWith("Ownable: caller is not the owner");
    });
  });
});