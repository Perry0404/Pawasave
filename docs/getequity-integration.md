# GetEquity Integration — Regulated RWA Yield for the Invest Tab

**Status:** Scoped, dark scaffold in place (`frontend/src/lib/getequity.ts`), flag-gated,
not wired to UI, not deployed. GetEquity is on **Base Sepolia testnet**; **Base mainnet
pending (~Aug 2026)**. Do not enable in production until mainnet contracts are live +
audited and regulatory questions below are answered.

## What GetEquity gives us

Tokenised **regulated** Nigerian investment products as ERC-20 "RWA tokens" on Base,
tradeable against a single Market contract, settling in **cNGN or USDC per asset**.
Debt/fund tokens accrue interest claimed via `claimPayout()`. This is the yield
inventory PawaSave's Invest tab has been missing (the slot ARM was going to fill —
and ARM's fund is already tokenised here anyway).

Products already tokenised on testnet:

| Symbol | Product | Type |
|---|---|---|
| **NTBL** | Nigerian Treasury Bill | debt / fixed-interest |
| **ANMF** | ARM NGN Mutual Fund | fund |
| CHDNRE | Chapel Hill Denham NREIT | REIT |
| DPRI | Dangote Refinery IPO | equity |

## Two surfaces — we take the on-chain one

- **REST API ("Members" white-label):** `Bearer` auth, base `ge-exchange.herokuapp.com/v1/`
  (sandbox `ge-exchange-staging-1.herokuapp.com/v1/`). `fund-invest` creates a payment
  link settled via **Flutterwave fiat** — re-introduces their fees and breaks the cNGN
  story. Only worth it if we did NOT already have on-chain rails. We do.
- **On-chain (chosen):** custody holds cNGN and calls the Market contract directly —
  the exact `approve → call` pattern as `supplyToLend`. Settles in cNGN, composable,
  transparent, no third fiat leg. This is the real "wrapper."

## Contracts (Base Sepolia — swap on mainnet launch)

| Contract | Address |
|---|---|
| Market (buy/sell) | `0x68543Dc71F76d0835e724dbEF898Dd010209C4bc` |
| cNGN (test) | `0x7E29CF1D8b1F4c847D0f821b79dDF6E67A5c11F8` |
| NTBL | `0xda42AEaC0A2ab7938C20Eb75221e9678f0d431aD` |
| ANMF / ARMNGF | `0xBdd5357A6c17B3d55Ab0A15C608d26A357c2C8C5` |

Chain ID `84532` (Sepolia). Mainnet not yet deployed.

### Live testnet inventory — verified on-chain 2026-09-23

GetEquity expanded the fixed-income catalogue on Sepolia and asked us to test it. All 8
tokens are `getRegisteredTokens()` on the Market above, 18-dp, settle in the test cNGN,
and — new since the original docs — **every token exposes `interestRateBps()` and
`tenorDays()`** (annual rate in bps, term in days). This answers "how many % is the
T-bill" trustlessly, read straight off the token:

| Symbol | Product | `interestRateBps` | Rate p.a. | Tenor | Token |
|---|---|---|---|---|---|
| **NTBL** | Nigerian Treasury Bill | 1620 | **16.20%** | 365d | `0xda42AEaC0A2ab7938C20Eb75221e9678f0d431aD` |
| **NTBS8** | Nigerian T-Bill Series 8 | 1650 | **16.50%** | 365d | `0x7A366C94bF530D0459a5E0fe72e54d81ED397674` |
| ARMNGF | ARM NGN Mutual Fund | 1850 | 18.50% | 365d | `0xBdd5357A6c17B3d55Ab0A15C608d26A357c2C8C5` |
| CDCSI | CredPal Debt Capital IV | 2500 | 25.00% | 365d | `0x0FDEd7FF4A8b3981Afa014651F62b982a9D52831` |
| PLLS1C | Precise Lighting CP Series 1 | 2500 | 25.00% | 365d | `0xC32656fDf2B09255B04fA1fFf12604076a0D1e5A` |
| FDNS2 | FCMB Debt Note Series 2 | 2900 | 29.00% | 364d | `0x58C4f0a34739aE16468BA4e2F552Dd7F60Ec509d` |
| CHDNRE | Chapel Hill Denham NREIT | 0 | — (REIT) | — | `0x06Abe3C18BcA4505da0A147FC1eF2898e480f840` |
| DPRI | Dangote Refinery IPO | 0 | — (equity) | — | `0x382Fb47b11107D9611a6aBAa28C907313D12C5bf` |

Notes from the live probe: buy/sell quotes work for every asset; per-asset fee is read
from `calculateBuyCost` (NTBL 1%, NTBS8/CDCSI/PLLS1C/FDNS2 2%). `calculatePayout(addr)`
reverts for a zero-balance holder, so accrual can only be exercised after an actual buy.
Our client (`getequity.ts` `listAssets`) and `/api/invest/getequity` now read and surface
`rateBps`/`tenorDays` on each card.

### Interface (already encoded in `getequity.ts`)

```
Market:  buy(token, amount, maxCost) / sell(token, amount, minPayout)
         calculateBuyCost / calculateSellPayout  (quotes)
         getRegisteredTokens / isAssetTradeable  (discovery)
RWA:     payoutToken()  ← settlement currency, ALWAYS read per asset
         hasMaturity / maturityDate / hasPeriodicPayouts
         calculatePayout(user) / claimPayout()   (interest)
```

## Architecture

1. **Custody-pooled (recommended for v1):** PawaSave custody buys/holds the RWA tokens;
   users hold a *ledger* position in PawaSave (like Lend/vault today). Simple, matches
   existing accounting, one on-chain position per asset. Redemptions honoured from
   custody's cNGN float + selling back to the Market.
2. **Per-user on-chain (v2):** each user's own wallet holds the token — trust-minimised
   but needs per-user gas + wallet UX. Defer.

Go with **custody-pooled v1**, mirroring how `supplyToLend` / P-AUTO already work.

## Client (built, dark)

`frontend/src/lib/getequity.ts` — flag-gated (`GETEQUITY_ENABLED` + `GETEQUITY_MARKET_ADDRESS`),
own provider (`GETEQUITY_RPC_URL`, since their chain ≠ our mainnet write RPC for now),
reuses `CUSTODY_PRIVATE_KEY`. Exports: `listAssets`, `quoteBuy`, `quoteSell`,
`custodyAssetBalance`, `pendingPayout`, `buyAsset`, `sellAsset`, `claimPayout`. Every
export no-ops/throws clearly unless enabled — inert until flipped on.

## Remaining work (when mainnet lands)

- **Env:** set `GETEQUITY_ENABLED`, `GETEQUITY_RPC_URL` (Base mainnet paid RPC),
  `GETEQUITY_MARKET_ADDRESS` (mainnet).
- **Ledger:** `investments` table (user, asset symbol, units, cost cNGN, status) + RPCs,
  mirroring the vault position model. Migration authored + run manually (per project rule).
- **API routes:** `/api/invest/getequity` (list assets, buy, sell, claim) — auth-gated,
  custody executes, ledger records, idempotent on a reference.
- **Invest tab UI:** surface NTBL/ANMF/etc. with tenor, interest, maturity, min; buy in
  cNGN; show accrued payout.
- **Reconciler:** a cron to `claimPayout()` on periodic assets and credit yield to the
  ledger (same shape as the idle-supply crons, guarded by a lock).
- **Deck/docs line (honest):** "Regulated investments (T-bills, funds) via GetEquity —
  on-chain, cNGN-settled — integration in progress."

## Diligence BEFORE enabling (blocking)

- **Regulatory:** who holds the license / which regulator (SEC Nigeria?), and is PawaSave
  *reselling* these to retail users compliant? Biggest open question.
- **Custody model:** confirm custody-pooled holding is acceptable to GetEquity + our terms.
- **Redemption liquidity:** can we sell back on demand to honour user withdrawals? What's
  the Market's liquidity / lockups per asset?
- **cNGN both ways:** confirm buy AND redeem settle in the *same* cNGN we use on Base mainnet.
- **Audits:** Market + RWA contracts audited before any mainnet custody exposure.
- **Do not gate PawaSave's launch on their mainnet timeline.**

## Sources

- API intro / auth: https://getequity.io/docs/api-reference/introduction.md
- On-chain model: https://getequity.io/docs/onchain/introduction.md
- EVM contracts: https://getequity.io/docs/onchain/ethereum-contracts.md
- Base addresses: https://getequity.io/docs/onchain/ethereum-addresses.md
- Docs index: https://getequity.io/docs/llms.txt