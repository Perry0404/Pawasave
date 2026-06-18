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

## Fixed in source — needs the v3 redeploy to go live
| ID | Sev | Note |
|----|-----|------|
| V2-SC-09 | Med | 🛠️ `setMaxDeviation` capped at 50% (can't disable the breaker). |
| V2-SC-10 | Low | 🛠️ `KeeperUpdated` event on `setKeeper`. |

## P0 — your action (no code)
| ID | Sev | Note |
|----|-----|------|
| V2-INFRA-05 | High | 🔵 Call `acceptOwnership()` on the vault from the Safe (2-step). Lend/Oracle/CreditLine ownership already transferred. |

## Remaining (P1/P2/P3) — mapped to the audit roadmap
| ID | Sev | Plan |
|----|-----|------|
| V2-MED-04 | Med | 🔵 Real KYC (Dojah/Smile) — deferred, your integration. Don't scale past beta cohort without it. |
| V2-MED-01 | Med | ⬜ P1 — vault `_withdraw` should pass through the strategy's actual returned amount (needs vault+strategy redeploy). |
| V2-MED-02 | Med | ⬜ P1 — add amount-range guard to `process_proxy_deposit` RPC. |
| V2-MED-05 | Med | ⬜ P2 — off-ramp `cngnToShares` shortfall handling. |
| V2-MED-06 | Med | ⬜ P2 — retry table for failed lend supplies via auto-contribute cron. |
| V2-INFRA-03 | Med | ⬜ P1 — complete root `.env.example` (frontend `.env.local.example` already documents AWS/sweep/secrets). |
| V2-INFRA-04 | Low | ⬜ P2 — `FallbackProvider` in cron jobs. |
| V2-LOW-03/04/05, V2-FE-01/02 | Low/Info | ⬜ P2 — rate cache, admin lockout, APY from `platform_settings`, vault dead-code, live APY projection. |
| V2-SC-01/03/05/08/11/12/13/15/16/17, V2-SC-02/04 | Low/Info | 🛠️/⬜ source comments, custom errors, oracle price floor, strategy pause/migration — bundle into the v3 redeploy. |
| V2-DEP-03, V2-INFRA-02 | Info | ⬜ P3 — frontend unit tests; production nonce-based CSP. |

**Recommended next:** address P1 items, then a **v3 re-audit** before scaling past the beta cohort (auditor's recommendation), plus the operational items (acceptOwnership, KYC, KMS).