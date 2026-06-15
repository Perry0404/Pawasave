# PawaSave — Security Audit Remediation Tracker

Tracks remediation of the 40 findings from the **End-to-End Security & Code Quality
Audit** (Blessed Tosin-Oyinbo / 0xTnxl, June 13 2026). Status legend:
✅ done · 🟡 in progress · ⬜ todo · 🔵 needs your account/decision · 🟣 won't-fix (justified)

> **Strategic note:** the lending pool has ≈0 TVL and 0 borrows. All contract
> findings can be fixed and redeployed cheaply *now*, before funds arrive.

## 7c — Redeployed to Base mainnet (June 13 2026) — PENDING RE-AUDIT
Patched (7a+7b) contracts are LIVE at new addresses; frontend repointed:

| Contract | Address |
|----------|---------|
| InterestRateModel | `0xfc9A201C08AB779003A142e9122A0fC94dfd7407` |
| PriceOracle | `0xE5D6B16e02bcf0B311feD6177f423fe5F860Bd1a` |
| PawasaveLend | `0x07F2365DDd5b720E55d0C04e1391A0aA92f2eaB7` |
| PawasaveLendStrategy (adapter) | `0xA98131D9A2C84870F7dc94BC122908Fe6064167F` |
| PawasaveAutoVault | `0x423750c8aa5f3008E342d8c764381a91550cCbB3` |

Verified on-chain: USDC/USDT/cNGN accepted; oracle prices seeded; adapter bound
to vault; pool unpaused. **Old contracts are abandoned (do not use).**

**Loan policy (live on this deployment):** max borrow **₦50M/user**; tenor **90d default
(30/180 options)**; **4-day grace** then overdue-liquidation; early repayment **free**.
Vercel env (`PRICE_ORACLE_ADDRESS`/`PAWASAVE_LEND_ADDRESS`/`PAUTO_VAULT_ADDRESS`) +
`FLIPEET_WEBHOOK_TOKEN` set. ✅ **migration 028 applied** (`withdraw_vault_atomic`,
`debit_wallet_with_fee`, `get_apy_settings`) — vault withdrawals atomic in prod.

## B2B credit lines — NEW module, staged for re-audit (NOT deployed)
`contracts/lending/PawasaveCreditLine.sol` — uncollateralised protocol-to-protocol
revolving credit (managed custody). Owner allowlists partners with a credit limit +
per-partner APR; simple interest folds into principal on every state change;
`draw` callable by the partner OR the owner (managed custody) to any settlement
address; `repay` open to anyone; `suspend`/`reactivate`/`writeOff`; `fund` /
`withdrawLiquidity` (idle only); Pausable + ReentrancyGuard + SafeERC20.
Tests: `test/credit-line.ts` — **11 passing** (full suite **68 passing**).
⚠ **Must be audited before deploy.** Managed partner API (Supabase partner table +
custody draw/repay/status endpoints) is the next build, gated on this audit.

## P0 — Before onboarding (live-money / takeover risk)

| ID | Finding | Status | Notes |
|----|---------|--------|-------|
| FIND-API-01 | Flipeet webhook unverified (CRIT-01) | ✅ | Secret token in callback URL, fail-closed (`FLIPEET_WEBHOOK_TOKEN`) |
| FIND-SC-11 | borrow() fee accounting (CRIT-04) | ✅ LIVE | Test proves NOT a bug (totalPoolAssets invariant); redeployed 7c |
| FIND-SC-13 | Liquidation uses stale `oracle.prices()` | ✅ LIVE | Uses `getPrice()`; redeployed 7c |
| FIND-FIN-02 | Xend webhook credits USD not cNGN | ✅ | Gated by `XEND_ENABLED` + math fixed to cNGN 1:1 |
| FIND-AUTH-01 | PIN hashed unsalted SHA-256 | ✅ | Server-side salted scrypt (lib/pin-hash.ts), backward-compatible upgrade-on-verify |

## P1 — Backend / auth (no redeploy)

| ID | Finding | Status | Notes |
|----|---------|--------|-------|
| FIND-API-03 | Xend webhook auth conditional | ✅ | Fail-closed when key absent |
| FIND-API-04 | Flint webhook auth conditional | ✅ | Fail-closed + gated by `FLINT_ENABLED` |
| FIND-API-06 | Cron accepts all if no secret | ✅ | Shared `checkCronAuth` — fail-closed |
| FIND-API-07 | Esusu yield endpoint unauthenticated | ✅ | Requires session + group membership |
| FIND-API-02 | Admin password in URL query | ✅ | Moved to POST body (password auth retained per product decision) |
| FIND-FE-01 | Admin password in sessionStorage | 🔵 | Password admin retained by decision; optional in-memory-only hardening |
| FIND-AUTH-03 | Admin single password, no MFA | 🔵 | Password retained by decision; MFA optional later |
| FIND-AUTH-02 | KYC ID unsalted SHA-256 | 🔵 | Defer to real-KYC integration (Dojah/Smile) — BVN hash isn't verified anywhere yet; salt it server-side at that point |
| FIND-FIN-04 | Vault withdrawal TOCTOU | ✅ | `withdraw_vault_atomic` (migration 028) + both client sites wired |

## P2 — Hardening

| ID | Finding | Status | Notes |
|----|---------|--------|-------|
| FIND-AUTH-05 | Open redirect in auth callback | ✅ | `next` must be a same-site relative path |
| FIND-FIN-01 | Inconsistent refund conversion | ⬜ | Batch 4 — canonical helpers |
| FIND-FIN-03 | Esusu hardcoded USD rate | ⬜ | Batch 4 — switch to cNGN 1:1 |
| FIND-FIN-05 | Fee recording not atomic | 🟡 | `debit_wallet_with_fee` (028) delivered; off-ramp records fee on provider success, adopt where debit+fee co-commit |
| FIND-FIN-06 | APY values hardcoded/inconsistent | 🟡 | `platform_settings` + `get_apy_settings()` (028) single source; frontend read pending (value tied to yield decision) |

> **✅ Done:** `supabase/migrations/028_audit_financial_fixes.sql` applied in Supabase (along with 026/027).
| FIND-API-05 | In-memory rate limiter | ✅ | Upstash-backed limiter + tighter limits on /api/admin & /api/ramp; in-memory fallback. Set UPSTASH_* to enable persistence |
| FIND-API-08 | Rate endpoint unauthenticated | ⬜ | Batch 4 — cache + limit |
| FIND-API-09 | Error messages leak internals | ✅ | Generic client messages; provider details logged server-side only |
| FIND-INFRA-01 | Empty next.config.js | ✅ | poweredByHeader off, strict mode, compress |
| FIND-INFRA-02 | No CSP | ✅ | CSP set in middleware (pragmatic, non-breaking) |
| FIND-INFRA-04 | No runtime kill-switch | 🔵 | Env flags (FLINT/XEND_ENABLED) gate today; DB kill-switch optional |
| FIND-INFRA-06 | No CI/CD / scanning | ✅ | GitHub Actions: tsc, lint, npm audit, hardhat compile/test, Slither |
| FIND-AUTH-04 | KYC not real verification | 🔵 | Known — Dojah/Smile ID integration pending |
| FIND-3P-03 | Xend defaults to staging URL | ✅ | Gated; will default prod when re-enabled |
| FIND-DEP-01 | No npm audit in pipeline | ✅ | npm audit (high+) in CI for frontend + contracts |

## Smart contracts

> ✅ = patched in source **and** unit-tested (`test/audit-fixes.ts`, 6 passing).
> **None of these are live until the single redeploy (7c)**, which is gated on the
> 7b vault redesign + a re-audit. Patches compile (`npx hardhat compile`).

**Batch 7a — contained patches (done, tested):**
| ID | Finding | Status |
|----|---------|--------|
| FIND-SC-04 | Harvest swallows errors | ✅ checks call result, emits HarvestFailed |
| FIND-SC-06 | `emergencyWithdraw()` no-op | ✅ now pulls funds back from strategies |
| FIND-SC-09 | harvestYield reverts on no yield | ✅ clean early-return |
| FIND-SC-11 | borrow() fee accounting | ✅ **verified NOT a bug** (test proves invariance) + documented |
| FIND-SC-13 | Liquidation stale price | ✅ uses `oracle.getPrice()` (staleness-enforced) |
| FIND-SC-14 | getCash bad-debt underflow | ✅ underflow-safe `totalPoolAssets` |
| FIND-SC-15 | Simple vs compound interest | ✅ documented (frequent accrual) |
| FIND-SC-16 | withdraw() lacks whenNotPaused | ✅ documented (intentional exit-always) |
| FIND-SC-17 | No per-user borrow cap | ✅ `maxBorrowPerUser` + setter |
| FIND-SC-19 | collateralList grows unbounded | ✅ trimmed on removeCollateral |
| FIND-SC-20 | Oracle no circuit breaker | ✅ deviation guard + forceSetPrice |
| FIND-SC-22 | Oracle staleness bypass | ✅ closed via SC-13 (no more raw `prices()`) |
| FIND-SC-25 | IRM not updatable | ✅ `setInterestRateModel` |
| FIND-SC-23 | cNGN price hardcoded | 🔵 informational — fetch live cNGN rate later |
| FIND-SC-24 | Rate-per-second truncation | 🟣 informational — negligible |

**Batch 7b — vault redesign (DONE in source + unit-tested; `test/vault-redesign.ts`, 7 passing; full suite 52 passing):**
| ID | Finding | Status |
|----|---------|--------|
| FIND-SC-01 | `_checkLocks()` O(n) DoS (Critical) | ✅ O(1) `lockedShares` counter; `releaseMatured()` for matured locks |
| FIND-SC-02 | Any lock blocks all withdrawals | ✅ only locked portion blocked; fixed deposits are self-only (anti-grief) |
| FIND-SC-03/08 | `totalAssets()` donation manipulation | ✅ internal `deployedAssets`; never reads strategy raw balance; +decimals offset |
| FIND-SC-05/07 | Strategy interface + timelock | ✅ `IStrategy` + asset sanity-check + 48h timelocked strategy changes |
| FIND-SC-04 | harvest swallows errors | ✅ `try/catch` + `HarvestFailed` event |
| FIND-SC-06 | emergencyWithdraw no-op | ✅ pulls all strategy funds back, then pauses |
| — | vault↔lend integration mismatch | ✅ new `PawasaveLendStrategy` adapter wraps supply/withdraw + deploy script wired |

> **Still gated:** none of 7a/7b is live until the single redeploy (7c), which needs
> your go + the deployer key, and which you've said will be re-audited first.

## Architecture (Batch 8 — needs your accounts/decisions)

| ID | Finding | Status | Notes |
|----|---------|--------|-------|
| FIND-3P-05 | Custody single key (CRIT-02) | 🟡 | `scripts/transfer-ownership.ts` moves CONTRACT ownership to a Safe (run post-redeploy). The custody EOA itself → Safe + per-tx limits is operational (needs your Safe) |
| FIND-3P-06 | Deposit mnemonic single secret (CRIT-03) | 🟡 | **Sweep-on-receipt shipped** (`lib/deposit-sweep.ts` + `/api/cron/sweep-deposits`, every 30m): drains per-user HD addresses to one custody address (gas-funded), so a mnemonic leak yields ~nothing. **Activate:** set `DEPOSIT_SWEEP_DESTINATION` (a COLD/Safe addr) in Vercel + fund the gas funder. Remaining: move the mnemonic itself to a secrets manager (needs cloud account) |
| FIND-SC-21 | Oracle keeper key in Vercel env | 🔵 | Operational: move keeper key to KMS/HSM (needs your KMS) |

> **Batch 8 code shipped:** Upstash rate limiter + `scripts/transfer-ownership.ts` (set `NEW_OWNER` to your Safe, run after the audited redeploy). The remaining items are key-custody operations that need your Safe/KMS accounts.
| FIND-3P-01 | Flipeet no request signing | 🟣 | Provider limitation; TLS + key rotation |
| FIND-3P-02 | Off-ramp refund single point | ⬜ | Batch 4 — reconciliation cron |
| FIND-3P-04 | NGN/USD fallback stale | ⬜ | Batch 4 |
| FIND-FE-02 | window.ethereum no validation | 🟣 | Accepted — standard web3; chain is validated before any signing. Not meaningfully fixable client-side |
| FIND-FE-03 | External login image | ✅ | `referrerPolicy="no-referrer"` + `loading="lazy"`; CSP `img-src` also constrains it |
| FIND-FE-04 | confirm() for consent | ✅ | New `ConfirmProvider` styled modal replaces native `confirm()` at all 3 sites (vault, goals, logout) |
| FIND-INFRA-03 | Hardcoded contract addrs | 🟣 | Public addresses; acceptable |
| FIND-INFRA-05 | Unpinned deps | ⬜ | Batch 5 |
| FIND-SC-18 | closeFactor ordering fragility | ⬜ | Batch 7 (no active bug) |