# Week 1 — Critical Remediation: Design

**Spec:** `week1-critical-remediation`
**Requirements:** `requirements.md` (R1–R10)
**Status:** Design — awaiting review before `tasks.md`

---

## 1. Approach

Two independent tracks, one shared prerequisite, one shared gate.

```
              ┌─────────────────────────────┐
              │ P0: Ground truth & forensics│  R1, R2
              │  schema recovery · damage   │  BLOCKS EVERYTHING
              └──────────┬──────────────────┘
                         │
         ┌───────────────┴───────────────┐
         ▼                               ▼
┌──────────────────────┐      ┌──────────────────────┐
│ Track A — data layer │      │ Track B — equity     │
│ R3 policies          │      │ R7 custody lease     │
│ R4 function grants   │      │ R8 reconciler        │
│ R5 RLS + views       │      │                      │
│ R6 withdrawal cap    │      │                      │
│ R9 defence in depth  │      │                      │
└──────────┬───────────┘      └──────────┬───────────┘
           └──────────────┬──────────────┘
                          ▼
              ┌─────────────────────────┐
              │ R10 Gate 1 verification │
              └─────────────────────────┘
```

Two principles govern every decision below.

**Prefer removing capability over adding logic.** Most of Track A is deleting a grant or a policy. Deleted capability cannot regress; added validation can be bypassed.

**Extend proven patterns rather than invent.** Migration 045's protective trigger and `cron/reconcile-withdrawals`'s guarded-claim `resolve()` both already work in this codebase. Two of the larger pieces of this design are those patterns applied to new tables.

---

## 2. Blocking prerequisite: schema recovery

Reconnaissance found something that changes the sequencing. **Eight functions are called by production code but have no definition anywhere in the repository:**

| Function | Called from | Why it matters |
|---|---|---|
| `try_acquire_lock`, `release_lock` | `lib/supply-lock.ts` | The only existing serialisation primitive — R7 depends on it |
| `pin_lock_status`, `record_pin_attempt` | `api/ramp`, `api/loans`, `api/security/pin` | **The PIN brute-force lockout.** Breaking these could silently disable it |
| `place_getequity_order`, `settle_getequity_order` | `api/invest/getequity` | A live money path |
| `create_ajo_invite`, `claim_ajo_invite` | USSD onboarding, client | Account creation |

All eight fall inside the missing migration range 046–061. `supply-lock.ts` names its backing migration as 054, which does not exist here.

**Consequence:** a blanket `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC` would hit these eight blind. We would not know whether they need a client grant, what guards they carry, or — for the PIN lockout — whether we had just disabled a security control while believing we had strengthened one.

**Design decision D0 — recover before revoking.**

1. Extract every function definition from production with `pg_get_functiondef`, plus the full grant and policy state.
2. Commit the recovered definitions as a baseline migration that documents rather than executes, the source of truth for what exists. **Claim the migration number at the moment of writing, not in advance.** It moved from 069 to 073 across a single day as teammates shipped 069 through 072, and the schema keeps moving, so re-take the snapshot immediately before the authorization migration rather than days ahead.
3. Only then write the authorization migration, with complete knowledge of all 87 functions.

This is R1 with a concrete, non-negotiable reason attached. It is also the point at which we discover whether production holds anything else the repo has never seen.

---

## 3. Track A design

### D1 — Function authorization model (R4)

The naive reading of R4 is "revoke everything, re-grant a little." Reconnaissance shows that is not safe: **27 functions are invoked from client-side code**, and they are not a homogeneous group. They sort into four categories, and only one of them is a pure SQL change.

**Category 1 — legitimately client-callable, keep the grant, audit the guard.**
User-initiated actions that debit the caller's own balance or read their own data:
`get_apy_settings`, `join_esusu_group`, `set_goal_auto_contribute`, `cast_emergency_vote`, `request_emergency_payout`, `complete_savings_goal`, `break_savings_goal`, `contribute_to_goal`, `process_esusu_payout`, `esusu_contribute`, `lock_savings`, `withdraw_lock`, `withdraw_vault_atomic`, `save_to_vault`

These stay callable by `authenticated`. Each is inspected for a correct guard. Note the guard idiom `IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN RAISE` is *sufficient* here — these debit the caller — but is **insufficient for any credit operation**, which is the distinction that produced `P3-C-02`.

**Category 2 — must move server-side. Route changes, not just grants.**

| Function | Why it cannot stay client-callable |
|---|---|
| `allocate_cngn_pool` | Credits the savings pool |
| `esusu_contribute_crypto` | Credits a group pot **with no debit and no auth check** |
| `record_lock_forfeiture`, `record_goal_forfeiture` | Write `revenue_journal` |
| `create_ajo_invite` | Mints invite codes that grant account creation |
| `proxy_transfer`, `register_proxy_member`, `get_proxy_transfers`, `get_proxy_member_for_user` | Operator functions and ledger reads |

Each needs a server route wrapping it, with the client switched to `fetch()` before the grant is removed. **This is the largest hidden cost in Track A** and the main reason Track A is not a one-day job.

**Category 3 — already revoked; the client calls are dead.**
`admin_fee_summary`, `admin_recent_fees`, `admin_tx_volume`, `admin_user_stats` are called from `admin-view.tsx` but were revoked from PUBLIC in `007_security_hardening`. Those calls therefore already fail; the dashboard works via `/api/admin/dashboard`. Delete the dead calls (same treatment as `updateTransactionPin` in R3.6).

**Category 4 — dead surface, revoke outright.**
Twenty functions are defined but never called from anywhere: `admin_deduct_revenue`, `admin_verify_kyc`, `calculate_lock_interest`, `compound_yield`, `debit_wallet_with_fee`, `enqueue_lend_supply`, `generate_deposit_address`, `get_fixed_savings_rate`, `get_flexible_pool_value`, `handle_new_user`, `is_group_member`, `_loan_equity_value`, `_loan_setting`, `protect_transaction_pin`, `record_yield_spread`, `reduce_flexible_pool`, `set_strails_account`, `set_transaction_deposit_address`, `submit_kyc`, `withdraw_from_vault`.

Note `handle_new_user`, `protect_transaction_pin` and `is_group_member` are invoked by triggers and policies, not by application code — they must keep working, but need no client grant. `submit_kyc` is notable: it sets `kyc_status` and is currently reachable, which is a second route to `P3-C-03`.

**Mechanism.** An explicit allow-list, not a blanket revoke:

```
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
-- then, one GRANT per Category 1 function, each with a comment stating why
GRANT EXECUTE ON FUNCTION public.<fn>(<args>) TO authenticated;
```

Rationale for allow-list over blanket-plus-exceptions: the failure mode of a missing grant is a visible error on a specific feature, which staging catches. The failure mode of a missed revoke is a silent money hole, which nothing catches. Bias toward the noisy failure.

**Ordering constraint:** Category 2 route changes ship *before* the revoke migration, or those features break.

### D2 — Column-level protection (R3)

Two mechanisms are available and they are not interchangeable.

**Drop the policy** where no client write is legitimate. Applies to `wallets` — reconnaissance confirmed zero live client writes, so the UPDATE policy has no reason to exist.

**Protective trigger** where the row must stay client-writable for some columns but not others. Applies to `profiles` (display name and preferences are legitimately client-editable; `kyc_status` is not) and to `savings_locks`.

The trigger pattern is already proven in migration 045:

```sql
IF NEW.<col> IS DISTINCT FROM OLD.<col>
   AND COALESCE(auth.role(), '') = 'authenticated' THEN
  RAISE EXCEPTION '<col> can only be changed by the server';
END IF;
```

Design decision: **extend 045's existing trigger rather than add sibling triggers.** One `BEFORE UPDATE` trigger on `profiles` guarding a set of columns (`transaction_pin_hash`, `kyc_status`, `kyc_type`, `kyc_id_hash`, `kyc_verified_at`, `strails_*`) is easier to reason about and to audit than four triggers with overlapping scope. Same for a new trigger on `savings_locks` covering `status`, `unlocks_at`, `amount_usdc_micro`, `projected_interest_micro`, `accrued_yield_micro`.

`submit_kyc` (Category 4) is revoked in the same migration, closing the second path to setting `kyc_status`.

### D3 — RLS and view exposure (R5)

**Four tables** get RLS with deny-by-default and explicit exceptions:

| Table | Client access |
|---|---|
| `revenue_journal` | None. Server-only. |
| `deposit_scan_state` | None. Single operational row; a client write breaks deposit crediting. |
| `fixed_savings_rates` | `SELECT` only — the app displays rates. No write. |
| `proxy_transfers` | None. Audit log. |

**Six views** recreated with `security_invoker = true`: `revenue_summary_daily`, `revenue_summary_monthly`, `revenue_by_type`, `platform_metrics`, `offramp_audit`, `yield_summary`.

Because migration 040 repointed the revenue views at `platform_fees` — which is RLS deny-all — adding `security_invoker` will make them return **zero rows** to a client, and zero rows to the *service role too* unless the admin path is checked. This is the trap in D3: the fix silently empties the admin dashboard if the dashboard reads the views with the anon key.

Mitigation: `/admin/revenue` is converted to fetch from a server route using the service-role client (which bypasses RLS), same as `/api/admin/dashboard` already does. That satisfies R5.4 and R5.5 together — the page gains authentication and keeps its numbers.

### D4 — Withdrawal ceiling (R6)

The existing `enforceWithdrawalKycCap` is correct but reads `kyc_status`, which the customer can currently write. Two changes, deliberately independent:

**A hard ceiling evaluated first**, before any tier logic and consulting no customer-controlled field:

```
validate amount (integer kobo, positive, ≤ HARD_MAX)
  → hard ceiling check        ← new, customer-independent
  → existing tier logic       ← unchanged
  → PIN verification          ← unchanged
  → debit
```

The hard ceiling is env-configured so it can be tuned without a deploy (R6.2), and it is logged on every rejection so its active value is observable.

**Amount validation moved to the entry point.** Currently `Number.isFinite` only. The design takes a single validated integer *kobo* value at the boundary and derives every downstream figure from it, so the ledger row and the on-chain send cannot round in opposite directions (R6.4).

Note this makes the cap belt-and-braces: after R3 lands, `kyc_status` is no longer customer-writable, so the tier logic becomes trustworthy again. The hard ceiling remains as defence in depth and as the mechanism for the interim measure leadership approved.

### D5 — Defence in depth (R9)

- `SET search_path = public, pg_temp` on every `SECURITY DEFINER` function. Applied during D0's recovery pass, since we are rewriting the definitions anyway.
- `CHECK (>= 0)` on every balance column. **Preceded by a scan for existing violations** — if any balance is already negative the constraint will fail to apply, and that is itself a finding worth surfacing.
- Uniqueness on provider references to prevent double-credit. Same precaution: scan for existing duplicates first, report before constraining.

---

## 4. Track B design

### D6 — Custody lease (R7)

The existing `supply-lock.ts` cannot be used as-is. Three problems:

1. **It fails open by design.** The docstring is explicit: it returns `true` on RPC error "so behaviour is unchanged until the migration is applied." R7.2 requires fail-closed.
2. **No fencing token.** `release_lock(p_key)` releases by key alone, so a slow process can release a lease another process now holds — then both proceed.
3. **Its source is missing** (D0), so its exact semantics are unknown.
4. **Single hardcoded key** `custody_supply`, so it cannot express "the custody signer is busy" as distinct from "a pool supply is in flight."

**Decision: write a new primitive, keep the old one as a wrapper.**

New `custody-lease.ts` with:
- **Fencing token.** `acquire()` returns an opaque token; `release(token)` is a no-op unless the token matches the current holder. Prevents cross-release.
- **Fail closed.** Any error acquiring is a failure to acquire. The caller aborts with a clear error rather than proceeding unserialised.
- **Bounded wait with jitter**, then clean failure. Never an unbounded block on a money path.
- **TTL with refresh** for long operations. HyperFX alone can take ~195s; a fixed 180s TTL can expire mid-order, which is how two holders arise.
- **Named scopes**, so `custody:signer` (every transaction from the custody key) is distinct from `custody:pool-supply`.

`acquireSupplyLock` becomes a thin wrapper over `custody:pool-supply` so existing call sites keep working unchanged during migration.

**Coverage (R7.6).** The lease must wrap *every* path signing with the custody key, not just equities: off-ramp `sendCngn`, `supplyToLend`, `withdrawFromLend`, `admin/supply-idle`, equity swaps, GetEquity, and HyperFX. Anything left outside can still collide on nonce.

**Held across both legs (R7.3).** `equity-broker.ts:363` currently releases after leg 1. It must not — the whole point is that no other custody operation runs while an order is measuring balance deltas.

**Attribution (R7.4).** Serialisation makes the balance-delta measurement safe, but it is still indirect. Where a receipt is available — the DEX swap — the design parses `Transfer`/`Swap` events from that specific transaction receipt instead of differencing wallet balances. HyperFX's solver fill has no receipt we control, so serialisation is the only available protection there, and that asymmetry is worth recording as accepted risk.

**Trade-off accepted.** Fail-closed plus serialisation means a Supabase outage or a long-running order will cause *visible order failures* under load. That is deliberate: a failed order is recoverable and a customer can retry; a cross-attributed order silently moves money between customers. We choose the loud failure.

### D7 — Equity reconciler (R8)

The largest build of the week. Modelled directly on `cron/reconcile-withdrawals`, which already solves the same problem correctly for a different money path.

**Reused pattern — guarded claim.** The proven `resolve()` idiom:

```
UPDATE ... SET status = <new> WHERE id = <id> AND status = 'pending' RETURNING id
  → zero rows means another run already handled it → do nothing
  → on money-move failure, revert to 'pending' so the next run retries
```

This is what makes the withdrawal reconciler double-refund-proof, and it is why I want the equity reconciler to look like it rather than be designed fresh.

**Resolution logic.** For each order or sale pending beyond a window:

| Evidence on chain | Resolution |
|---|---|
| Stock tokens received by custody, attributable to this order | Settle `filled` |
| No stock received, cNGN never left custody | Refund |
| cNGN escrowed but no stock received (the `P3-H-04` case) | Refund the customer, **and flag for operator review** — the ledger and custody now disagree and that divergence must be recorded, not absorbed |
| Ambiguous | Leave pending, increment attempt count, alert. Never guess. |

The third row is the important design point. Today that case silently refunds in the database while custody holds the wrong asset. The reconciler will still make the customer whole, but it will also **write the divergence to a reconciliation ledger** so the aggregate is visible rather than accumulating invisibly. Satisfies R8.5.

**Durable order state (R8.4).** `equity_orders` needs enough state to be resumable: which leg completed, the HyperFX order reference, the swap transaction hash, an attempt counter, and a `started_at` for staleness. Additive columns only. The route declares an explicit `maxDuration`.

**Authorization.** Fails closed via the existing `checkCronAuth`, consistent with every other cron (R8.6).

**Backfill (R8.7).** The stranded rows R2 finds are resolved by the same reconciler rather than by hand-written SQL — the code path we intend to rely on gets exercised against the real backlog, which is the best test available.

---

## 5. Migration plan

Ordering is load-bearing. Category 2 route changes must precede the revoke; view changes must precede the admin-page change or the dashboard empties.

| # | Change | Type | Depends on |
|---|---|---|---|
| 0 | Recover production schema, commit baseline `069` | Recovery | — |
| 1 | Forensics queries + reconciliation report | Read-only | 0 |
| 2 | Additive columns for durable order state | Migration | 0 |
| 3 | Custody lease table + RPCs | Migration | 0 |
| 4 | `custody-lease.ts`; wrap all custody paths | Code | 3 |
| 5 | Equity reconciler + cron route | Code | 2, 4 |
| 6 | Resolve the stranded backlog | Operational | 5 |
| 7 | Category 2 server routes; client switched to `fetch` | Code | 0 |
| 8 | Delete dead paths (`updateTransactionPin`, dead admin RPC calls) | Code | 7 |
| 9 | Views with `security_invoker`; `/admin/revenue` server route | Migration + code | 0 |
| 10 | Hard withdrawal ceiling + amount validation | Code | — |
| 11 | **Authorization migration** — policies, triggers, RLS, revoke/grant, `search_path`, CHECKs, uniqueness | Migration | 7, 8, 9 |
| 12 | Adversarial test suite | Tests | 11 |

Steps 2–6 (Track B) and 7–11 (Track A) are independent after step 1 and can proceed in parallel.

Step 11 is deliberately one migration, not several. The authorization changes are a single logical state transition; splitting them creates windows where policies are dropped but grants are not yet tightened.

## 6. Rollback (R10.5)

| Change | Rollback |
|---|---|
| Authorization migration (11) | Paired `down` script restoring prior policies and grants, tested on staging. Prior state captured verbatim in step 0's baseline. |
| Views | Recreate without `security_invoker` |
| Additive columns (2) | Left in place — harmless, and dropping loses reconciliation state |
| Custody lease (3, 4) | Feature-flagged. Disabling reverts to current behaviour. Fail-closed becomes fail-open only via explicit flag, never silently |
| Reconciler (5) | Disable the cron. It only ever resolves rows that are already stuck |
| Ceiling (10) | Env value raised; code path is additive |

The riskiest step is 11 and it is the one with the cleanest rollback, because step 0 gives us the exact prior state to restore.

## 7. Verification design (R10)

**Adversarial suite** — runs as an ordinary authenticated user against staging using the public anon key, exactly as an attacker would. Each case asserts *failure*:

1. `UPDATE wallets SET usdc_balance_micro = <large>` on own row
2. `UPDATE profiles SET kyc_status = 'verified'` on own row
3. `UPDATE savings_locks SET status = 'matured', unlocks_at = <past>` on own row
4. Direct `rpc()` on each credit-side function
5. Direct `rpc()` on `place_equity_order`, `place_equity_sell`, `create_loan`, `repay_loan`
6. `SELECT` on `platform_fees` and each revenue view
7. `UPDATE deposit_scan_state SET last_block = 999999999`
8. `rpc('submit_kyc')` to self-verify
9. Withdrawal exceeding the hard ceiling, with `kyc_status` self-set first

**Concurrency suite** — two simultaneous equity orders must not be attributed each other's output; two simultaneous withdrawals against one balance must not both succeed.

**Interruption test** — an order killed mid-flight must be resolved by the reconciler to filled or refunded, never left pending.

**Regression pass (R10.4)** — every money path exercised on staging by hand: deposit, withdrawal, lock and release, goal contribution, esusu contribution and payout, equity buy and sell, loan borrow and repay, admin dashboard. This is what catches a missing grant, and it is not optional.

## 8. Decisions log

| ID | Decision | Rationale |
|---|---|---|
| D0 | Recover production schema before revoking | Eight functions have no source, two of them are the PIN lockout |
| D1 | Explicit allow-list, not blanket revoke with exceptions | Missing grant fails loudly; missed revoke fails silently |
| D1b | Category 2 moves server-side before grants change | Otherwise those features break |
| D2 | Drop policy on `wallets`; extend 045's trigger for `profiles` / `savings_locks` | Some columns are legitimately client-writable, some are not |
| D3 | `/admin/revenue` becomes a server route | `security_invoker` would otherwise empty the dashboard |
| D4 | Hard ceiling evaluated before tier logic | Must not depend on a customer-writable field |
| D5 | New `custody-lease.ts`; `supply-lock` becomes a wrapper | Existing lock fails open, has no fencing token, and its source is missing |
| D6 | Fail closed, accepting visible failures under load | A failed order is recoverable; a cross-attributed order is not |
| D7 | Reconciler mirrors `reconcile-withdrawals` | That pattern is already proven double-refund-proof here |
| D8 | Ledger/custody divergence is recorded, not absorbed | Otherwise unbacked balance accumulates invisibly |
| D9 | Authorization changes ship as one migration | Splitting creates partially-secured windows |

## 9. Open items

Carried from requirements, still needed:

1. **Interim hard ceiling value** — blocks D4 implementation, not its design.
2. **Thin-pool symbols** — leadership decision; independent of this design.
3. **`USSD_ENABLED` state** — if on, `P3-C-05` needs a requirement and a design section this week.
4. **Customer remediation policy** — shapes what step 6 commits to.

New, arising from this design:

5. **Does production contain anything else the repo has never seen?** Step 0 answers this. If the 046–061 gap holds tables or policies as well as functions, scope grows and I will bring a revised estimate rather than absorb it silently.
6. **HyperFX attribution has no receipt-level protection.** Serialisation is the only defence available on that leg. Recorded as accepted risk; revisit if the intent API can return a verifiable fill reference.

---

*Design only. Task breakdown follows in `tasks.md` once this is agreed.*
