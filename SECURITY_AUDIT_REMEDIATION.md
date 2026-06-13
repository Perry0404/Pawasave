# PawaSave — Security Audit Remediation Tracker

Tracks remediation of the 40 findings from the **End-to-End Security & Code Quality
Audit** (Blessed Tosin-Oyinbo / 0xTnxl, June 13 2026). Status legend:
✅ done · 🟡 in progress · ⬜ todo · 🔵 needs your account/decision · 🟣 won't-fix (justified)

> **Strategic note:** the lending pool has ≈0 TVL and 0 borrows. All contract
> findings can be fixed and redeployed cheaply *now*, before funds arrive.

## P0 — Before onboarding (live-money / takeover risk)

| ID | Finding | Status | Notes |
|----|---------|--------|-------|
| FIND-API-01 | Flipeet webhook unverified (CRIT-01) | ✅ | Secret token in callback URL, fail-closed (`FLIPEET_WEBHOOK_TOKEN`) |
| FIND-SC-11 | borrow() fee accounting (CRIT-04) | ⬜ | Batch 7 redeploy + test (my trace: over-rated, still fix) |
| FIND-SC-13 | Liquidation uses stale `oracle.prices()` | ⬜ | Batch 7 — switch to `getPrice()` |
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
| FIND-FIN-04 | Vault withdrawal TOCTOU | ⬜ | Batch 4 — atomic RPC |

## P2 — Hardening

| ID | Finding | Status | Notes |
|----|---------|--------|-------|
| FIND-AUTH-05 | Open redirect in auth callback | ✅ | `next` must be a same-site relative path |
| FIND-FIN-01 | Inconsistent refund conversion | ⬜ | Batch 4 — canonical helpers |
| FIND-FIN-03 | Esusu hardcoded USD rate | ⬜ | Batch 4 — switch to cNGN 1:1 |
| FIND-FIN-05 | Fee recording not atomic | ⬜ | Batch 4 |
| FIND-FIN-06 | APY values hardcoded/inconsistent | ⬜ | Batch 4 — platform_settings source of truth |
| FIND-API-05 | In-memory rate limiter | 🔵 | Batch 8 — needs Upstash |
| FIND-API-08 | Rate endpoint unauthenticated | ⬜ | Batch 4 — cache + limit |
| FIND-API-09 | Error messages leak internals | ⬜ | Batch 4 — generic client messages |
| FIND-INFRA-01 | Empty next.config.js | ✅ | poweredByHeader off, strict mode, compress |
| FIND-INFRA-02 | No CSP | ✅ | CSP set in middleware (pragmatic, non-breaking) |
| FIND-INFRA-04 | No runtime kill-switch | 🔵 | Env flags (FLINT/XEND_ENABLED) gate today; DB kill-switch optional |
| FIND-INFRA-06 | No CI/CD / scanning | ✅ | GitHub Actions: tsc, lint, npm audit, hardhat compile/test, Slither |
| FIND-AUTH-04 | KYC not real verification | 🔵 | Known — Dojah/Smile ID integration pending |
| FIND-3P-03 | Xend defaults to staging URL | ✅ | Gated; will default prod when re-enabled |
| FIND-DEP-01 | No npm audit in pipeline | ✅ | npm audit (high+) in CI for frontend + contracts |

## Smart contracts (Batch 7 — one redeploy while TVL=0)

| ID | Finding | Status |
|----|---------|--------|
| FIND-SC-01 | `_checkLocks()` O(n) DoS | ⬜ |
| FIND-SC-02 | Any lock blocks all withdrawals | ⬜ |
| FIND-SC-03/08 | `totalAssets()` donation manipulation | ⬜ |
| FIND-SC-04 | Harvest swallows errors | ⬜ |
| FIND-SC-05/07 | Strategy interface + timelock | ⬜ |
| FIND-SC-06 | `emergencyWithdraw()` no-op | ⬜ |
| FIND-SC-09 | harvestYield reverts on no yield | ⬜ |
| FIND-SC-11 | borrow() fee accounting | ⬜ |
| FIND-SC-13 | Liquidation stale price | ⬜ |
| FIND-SC-14 | getCash bad-debt underflow | ⬜ |
| FIND-SC-15 | Simple vs compound interest | ⬜ |
| FIND-SC-16 | withdraw() lacks whenNotPaused (doc) | ⬜ |
| FIND-SC-17 | No per-user borrow cap | ⬜ |
| FIND-SC-19 | collateralList grows unbounded | ⬜ |
| FIND-SC-20 | Oracle no circuit breaker | ⬜ |
| FIND-SC-22 | Oracle staleness bypass | ⬜ |
| FIND-SC-23 | cNGN price hardcoded | ⬜ |
| FIND-SC-24 | Rate-per-second truncation | ⬜ |
| FIND-SC-25 | IRM not updatable | ⬜ |

## Architecture (Batch 8 — needs your accounts/decisions)

| ID | Finding | Status | Notes |
|----|---------|--------|-------|
| FIND-3P-05 | Custody single key (CRIT-02) | 🔵 | Migrate to Gnosis Safe multisig |
| FIND-3P-06 | Deposit mnemonic single secret (CRIT-03) | 🔵 | Sweep-on-receipt + KMS |
| FIND-SC-21 | Oracle keeper key in Vercel env | 🔵 | KMS/HSM |
| FIND-3P-01 | Flipeet no request signing | 🟣 | Provider limitation; TLS + key rotation |
| FIND-3P-02 | Off-ramp refund single point | ⬜ | Batch 4 — reconciliation cron |
| FIND-3P-04 | NGN/USD fallback stale | ⬜ | Batch 4 |
| FIND-FE-02 | window.ethereum no validation | ⬜ | Batch 6 |
| FIND-FE-03 | External login image | ⬜ | Batch 6 |
| FIND-FE-04 | confirm() for consent | ⬜ | Batch 6 |
| FIND-INFRA-03 | Hardcoded contract addrs | 🟣 | Public addresses; acceptable |
| FIND-INFRA-05 | Unpinned deps | ⬜ | Batch 5 |
| FIND-SC-18 | closeFactor ordering fragility | ⬜ | Batch 7 (no active bug) |