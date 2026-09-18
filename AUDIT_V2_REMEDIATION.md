# PawaSave — Audit v2 Remediation Tracker

Tracks the 43 new findings from **Audit Report v2** (0xTnxl, June 2026). v1's 40
findings are tracked in `SECURITY_AUDIT_REMEDIATION.md`. Overall risk: **MEDIUM**.

Status: ✅ fixed in code · 🛠️ fixed in source, **needs the next redeploy to go live** ·
🔵 needs your account/decision · ⬜ todo (P2/P3) · 🟣 won't-fix.

> ⚠️ **Deployed-contract source fixes are NOT live yet.** The 7d oracle/vault/lend/
> strategy are already on-chain, so any contract change below (e.g. oracle 50% cap)
> only takes effect on the **next redeploy (v3)**. The **CreditLine** is still
> undeployed, so its fixes are correct as soon as it's deployed.

## Done this session (code)
| ID | Sev | Status | Note |
|----|-----|--------|------|
| V2-HIGH-01 | High | ✅ LIVE | CreditLine: drawn principal vs accrued interest tracked separately — interest never consumes draw headroom; repay/writeOff interest-first. Tests rewritten (13). **Redeployed to `0x5056520eDF1efF1c18aD924a8Abd76b189221B13`** (owner=Safe); old `0x723CF2c9…` abandoned. |
| V2-HIGH-02 | High | ✅ | `clearSecretsCache()` + `/api/admin/clear-secrets-cache` + `SECRETS_TTL_MS` env for fast key rotation. |
| V2-HIGH-03 | High | ✅ | Admin auth → httpOnly HMAC session cookie (`lib/admin-session.ts`); password no longer in `sessionStorage`. New `/api/admin/logout`. |
| V2-MED-03 | Med | ✅ | Off-ramp refunds + fails when Flipeet returns no deposit address. |
| V2-SC-19 | Low | ✅ | CreditLine `MIN_REPAY` floor (full pay-off of small debts still allowed). |
| V2-SC-20 | Info | ✅ | CreditLine `totalWrittenOff` counter + `reason` in `WrittenOff`. |
| V2-SC-21 | Med | ✅ | CreditLine simple-interest documented; daily accrual cron recommended. |
| V2-SC-22 | Med | ✅ | CreditLine `idleLiquidity()` semantics clarified (drawn funds already leave the contract). |
| V2-LOW-01 | Low | ✅ | Canonical `koboToCngnMicro` / `cngnMicroToKobo` helpers in `ramp-rate.ts`. |
| V2-LOW-02 | Low | ✅ | Esusu yield uses cNGN 1:1 (no USD/NGN detour). |
| V2-INFRA-01 | Med | ✅ | CI `npm audit --audit-level=high` now blocks (removed `continue-on-error`). |
| V2-DEP-02 | Info | ✅ | `@aws-sdk/client-secrets-manager` pinned to exact `3.1068.0`. |
| FIND-3P-04 | Low | ✅ | NGN/USD fallback rate 1550 → 1650. |
| V2-MED-02 | Med | ✅ | `process_proxy_deposit` amount floor + cap (migration `029`); cap tunable via `platform_settings('max_proxy_deposit_micro')`, default ₦100M. |
| V2-MED-05 | Med | ✅ | Off-ramp uses the lend withdrawal's ACTUAL realised cNGN + a custody-balance guard before sending; refunds on shortfall (`ramp/route.ts`, `custodyCngnBalance()`). |
| V2-MED-06 | Med | ✅ | Durable retry queue for failed PawasaveLend supplies: table + RPCs (migration `030`), webhook enqueues on failure, `auto-contribute` cron drains it. |
| V2-INFRA-03 | Med | ✅ | Root `.env.example` completed (deploy/keeper/collateral/contract-address vars). |
| V2-INFRA-04 | Low | ✅ | `lib/rpc-provider.ts` FallbackProvider (primary + `BASE_RPC_FALLBACKS` + public fallbacks); wired into all crons + custody/sweep/scan libs. |
| V2-LOW-03 | Low | ✅ | Last-good rate cache in `ramp-rate.ts` (TTL + stale-on-error instead of jumping to the static fallback). |
| V2-LOW-04 | Low | ✅ | DB-backed admin login lockout keyed by IP — 5 fails → 15-min lock (migration `031`, wired into `/api/admin/verify`). |
| V2-LOW-05 | Low | ✅ | `getApySettings()` reads canonical APYs from `get_apy_settings()` (single source of truth). |
| V2-FE-01 | Info | ✅ | Removed vault dead code (`executeFlexible`, `flexAction`, `savingsKobo`, orphan imports). |
| V2-FE-02 | Info | ✅ | Flexible APY label is now live from `platform_settings` in `vault-view.tsx`. |

## Fixed in source — needs the v3 redeploy to go live
| ID | Sev | Note |
|----|-----|------|
| V2-SC-09 | Med | 🛠️ `setMaxDeviation` capped at 50% (can't disable the breaker). |
| V2-SC-10 | Low | 🛠️ `KeeperUpdated` event on `setKeeper`. |
| V2-MED-01 | Med | 🛠️ Vault `_withdraw` acts on each strategy's ACTUAL returned amount, tops up from fallback, and reverts on a genuine shortfall instead of under-delivering / desyncing `deployedAssets`. Tests added. |
| V2-SC (oracle floor) | Low | 🛠️ `PriceOracle` per-token `minPrice` floor (applies even to `forceSetPrice`) so a near-zero feed glitch can't be written on the first update. Tests added. |
| V2-SC-02/04 | Low | 🛠️ `PawasaveLendStrategy.setPaused()` blocks new deposits (withdraw/harvest stay open) so a suspect pool can be wound down and migrated via the vault timelock. Tests added. |

## P0 — your action (no code)
| ID | Sev | Note |
|----|-----|------|
| V2-INFRA-05 | High | 🔵 Call `acceptOwnership()` on the vault from the Safe (2-step). Lend/Oracle/CreditLine ownership already transferred. |

## Remaining (P1/P2/P3) — mapped to the audit roadmap
| ID | Sev | Plan |
|----|-----|------|
| V2-MED-04 | Med | 🔵 Real KYC (Dojah/Smile) — deferred, your integration. Don't scale past beta cohort without it. |
| V2-SC-01/03/05/08/11/12/13/15/16/17 | Low/Info | ⬜ Remaining SC items = NatSpec/comments + a custom-errors gas refactor. The custom-errors change is deliberately deferred: it would break the existing revert-string assertions across the 84-test suite for an Info-level gas win. Do it in the v3 PR alongside fresh tests. |
| V2-DEP-03, V2-INFRA-02 | Info | ⬜ P3 — frontend unit tests; production nonce-based CSP. |

### New migrations to run (Supabase)
`029_proxy_deposit_amount_guard.sql`, `030_pending_lend_supplies.sql`, `031_admin_login_throttle.sql`.

### Optional new env (all have safe defaults)
`BASE_RPC_FALLBACKS` (comma-separated extra Base RPCs), `RATE_CACHE_TTL_MS`.

### On-ramp provider split (cNGN liquidity)
On-ramp now routes fiat → cNGN through **Flint** (delivers cNGN to custody, then
supplies it into PawasaveLend as borrower liquidity); **Flipeet is off-ramp only**
(it doesn't accept cNGN on-ramp). The Flint webhook credits cNGN **1:1** (no more
legacy USD-rate path) and enqueues a lend-supply retry on failure. To enable the
fiat on-ramp, set `FLINT_ENABLED=true`, `FLINT_API_KEY`, `FLINT_WEBHOOK_SECRET`,
`FLINT_CUSTODY_ADDRESS`, `FLINT_ASSET=cngn`. Until then, users can still deposit
cNGN directly to their per-user deposit address (the scanner credits it 1:1).

**Recommended next:** run the 3 new migrations, then bundle the 🛠️ source fixes into a **v3 stack redeploy** (oracle is `immutable`, so lend/oracle/vault/strategy go together) and a **v3 re-audit** before scaling past the beta cohort. Operational items still open: `acceptOwnership()` on the vault, Safe 3-of-3 → 2-of-3, real KYC, keeper keys → KMS, rotate the deployer key out of the Safe signers.