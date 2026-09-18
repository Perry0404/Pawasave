# Week 1 — Critical Remediation: Requirements

**Spec:** `week1-critical-remediation`
**Source:** `PAWASAVE_AUDIT_2026-09_AND_PLAN.md` (revision 2), Section 6 Week 1
**Branch under change:** `audit-v2-remediation-and-flint-onramp`
**Target gate:** Audit Gate 1
**Status:** Requirements — awaiting review before design

---

## 1. Objective

Close the two paths by which PawaSave is currently losing or can lose customer money, and prove they are closed.

Those two paths fail by different mechanisms, and the distinction drives everything below:

| | Track A — data layer | Track B — equity path |
|---|---|---|
| Mechanism | Deliberate exploitation | Ordinary concurrent use |
| Needs an attacker | Yes | **No** |
| Probability | Low, roughly constant | Rises with usage |
| Findings | `P3-C-01`, `P3-C-02`, `P3-C-03` | `P3-H-01`, `P3-H-03`, `P3-H-04` |

Track A is a vulnerability. Track B is an active malfunction. Both are in scope this week; neither waits on the other.

## 2. Scope

**In scope**
- Database authorization: row-level policies, function execute grants, RLS coverage, view invoker semantics
- A withdrawal ceiling that cannot be lifted by the customer
- Equity order integrity: custody serialisation, order reconciliation, durable order state
- Forensics quantifying damage already done
- An adversarial test suite that constitutes the gate

**Out of scope this week** (scheduled later, tracked in the audit)
- Buy-side fair-value floor, HyperFX fill threshold, MAX approval replacement — Week 2
- Residency / US-person gate (`P3-H-17`) — Week 2
- Admin auth rebuild (`P3-H-08`) — Week 2
- All contract changes including the vault lock bypass (`P3-C-04`) — Week 3
- Double-entry ledger — pending decision

**Explicitly not a goal:** shipping new product behaviour. Every change here either removes an unintended capability or adds a guard. If a change alters what a legitimate customer can do, that is a defect in this spec.

## 3. Reconnaissance already completed

Two facts were verified before writing this spec, because they determine risk:

**3.1 — There are no live client-side writes to `wallets`, `profiles` or `savings_locks`.** Every `.update()` against those tables lives in a server route handler using a service-role client. The sole client-side write is `updateTransactionPin` (`frontend/src/hooks/use-data.ts:436-445`), which has **zero callers** — the UI already posts to `/api/security/pin` — and which migration 045's trigger would reject anyway.

*Consequence:* dropping the client UPDATE policies is a near-zero-blast-radius change, not the risky one it appears to be. This must be re-verified against production before the migration runs, since the repository may not match what is deployed.

**3.2 — Migration 045 establishes the pattern to reuse.** It protects `profiles.transaction_pin_hash` with a `BEFORE UPDATE` trigger that rejects changes made under the `authenticated` role. The same mechanism applies directly to `kyc_status` and to `savings_locks.status`, so we are extending an existing, proven approach rather than inventing one.

---

## 4. Requirements

### R1 — Ground truth is established before any change is made

**Story:** As the engineer making these changes, I need to know what is actually deployed, because the repository is not a reliable description of production.

**Acceptance criteria**
1. WHEN the production schema is dumped and diffed against all 55 migration files, THEN every discrepancy SHALL be recorded, and any discrepancy touching `wallets`, `profiles`, `savings_locks`, function grants or RLS SHALL be resolved before the migration is written.
2. WHEN the diff is complete, THEN it SHALL be recorded which of the three `007` files and which of the two `017` files is live, since two of them define `record_platform_fee` differently and only one carries REVOKEs.
3. WHEN production environment variables are inspected, THEN the state of `USSD_ENABLED` SHALL be confirmed. (`EQUITY_ENABLED` and `HYPERFX_ENABLED` are confirmed on.)
4. WHEN a local environment is restored, THEN the existing contract test suite SHALL run to completion and its true pass/fail state SHALL be recorded, replacing the tracker's unverified claim.
5. IF production schema differs from the repository in any way that changes a finding's validity, THEN the audit document SHALL be updated before remediation proceeds.

### R2 — Damage already done is quantified

**Story:** As the business, we need to know what these defects have already cost before we decide how to make customers whole.

**Acceptance criteria**
1. WHEN `equity_orders` is queried for rows in `pending` older than the settlement window, THEN each stranded order SHALL be listed with its customer, amount and age, and the total customer money in limbo SHALL be reported as a single figure.
2. WHEN `equity_sales` is queried likewise, THEN each stranded sale SHALL be listed with the shares and cost basis already removed from the customer's holding.
3. WHEN filled orders and sales are examined for implied FX rate, THEN outliers SHALL be identified as candidate cross-order contamination (`P3-H-01`), and any two orders created inside the ~4-minute contamination window SHALL be flagged.
4. WHEN `portfolio_holdings.shares` is summed per symbol and compared against the omnibus custody wallet's actual on-chain token balances, THEN any shortfall SHALL be reported per symbol and in aggregate. This figure is the realised cost of `P3-H-01` and `P3-H-04`.
5. WHEN customer balances are reconciled against deposit and transaction history, THEN any balance not explicable by recorded history SHALL be reported. This detects whether `P3-C-01` has been exploited.
6. WHEN forensics are complete, THEN a written summary SHALL be produced stating what was found, what it cost, and which customers are affected.
7. All forensic queries SHALL be read-only. No forensic step SHALL mutate data.

### R3 — Customers cannot write their own balance, KYC status or lock status

**Story:** As a customer, I must not be able to alter my own financial state directly; as the business, our controls must not rest on fields customers can edit.

**Findings:** `P3-C-01`, `P3-C-03`

**Acceptance criteria**
1. WHEN an authenticated client attempts `UPDATE` on its own `wallets` row, THEN the operation SHALL fail.
2. WHEN an authenticated client attempts to set `profiles.kyc_status`, THEN the operation SHALL fail. Service-role writes SHALL continue to succeed.
3. WHEN an authenticated client attempts to alter `savings_locks.status`, `unlocks_at`, `amount_usdc_micro` or `projected_interest_micro`, THEN the operation SHALL fail.
4. WHEN a legitimate customer performs any existing product action — deposit, withdrawal, savings lock, goal contribution, esusu contribution, PIN change, equity buy or sell, loan — THEN it SHALL continue to succeed unchanged.
5. WHEN the change is designed, THEN column-level protection SHALL follow migration 045's trigger pattern for columns that must remain client-readable but not client-writable, rather than inventing a new mechanism.
6. WHEN `updateTransactionPin` in `use-data.ts` is confirmed to have no callers, THEN it SHALL be deleted rather than left as a broken path.

### R4 — Privileged database functions are not callable by clients

**Story:** As the business, functions that move money must be invocable only by our server, not by anyone holding the public anon key.

**Finding:** `P3-C-02`

**Acceptance criteria**
1. WHEN EXECUTE is revoked from `PUBLIC`, `anon` and `authenticated` across the schema and re-granted selectively, THEN the set of functions callable by a client SHALL be explicitly enumerated and justified, and SHALL exclude every function that credits a balance.
2. WHEN a client calls `credit_wallet`, `credit_crypto_deposit`, `distribute_vault_yield`, `allocate_cngn_pool` or `debit_wallet` directly, THEN the call SHALL fail with insufficient privilege.
3. WHEN a client calls `place_equity_order`, `place_equity_sell`, `create_loan` or `repay_loan` directly, THEN the call SHALL fail, so that route-level guards — broker-live checks, catalog membership, minimum amounts, fair-value floors — cannot be bypassed (`P3-H-07`).
4. WHEN the re-grant list is produced, THEN every retained client-callable function SHALL be inspected for a correct authorization guard, and any guard of the form "reject when `auth.uid() != p_user_id`" SHALL be recognised as insufficient for credit operations.
5. WHEN every server call site is reviewed, THEN each SHALL be confirmed to use a service-role client for functions that are becoming service-role-only. Any call site relying on the user's session for such a function SHALL be migrated before the revoke lands.
6. WHEN the migration is applied, THEN all existing server-side flows SHALL continue to work — verified by exercising each money path, not by inspection alone.

### R5 — No table or view is exposed to clients unintentionally

**Story:** As the business, operational and revenue data must not be readable or writable by customers.

**Findings:** `P3-M-02`, `P3-M-03`

**Acceptance criteria**
1. WHEN RLS is enabled on `revenue_journal`, `deposit_scan_state`, `fixed_savings_rates` and `proxy_transfers`, THEN each SHALL carry explicit policies, and client read or write access SHALL be denied unless a specific product need is documented.
2. WHEN `deposit_scan_state` is protected, THEN a client SHALL NOT be able to modify `last_block`, since advancing it silently stops customer deposits being credited.
3. WHEN all six views are recreated with `security_invoker = true`, THEN a client querying them SHALL see only rows the underlying tables' RLS permits, and `platform_fees` SHALL remain unreachable by clients.
4. WHEN `/admin/revenue` is loaded without a valid admin session, THEN it SHALL NOT render revenue data.
5. WHEN the admin dashboard is used with a valid session, THEN every figure it displayed before SHALL still display.

### R6 — The withdrawal ceiling cannot be lifted by the customer

**Story:** As the business, the withdrawal cap leadership believes is in force must actually be in force.

**Findings:** `P3-H-09`, `P3-M-17`; leadership approval recorded 5 Sept

**Acceptance criteria**
1. WHEN a withdrawal is requested, THEN a hard maximum SHALL be enforced **before and independently of** the KYC-tier logic, so that it cannot be bypassed by a customer altering their own `kyc_status`.
2. WHEN the interim ceiling approved by leadership is configured, THEN it SHALL be settable without a deploy and its active value SHALL be observable in logs or an admin view.
3. WHEN a withdrawal amount is not a valid monetary value — non-finite, negative, or more than two decimal places — THEN it SHALL be rejected before any debit occurs.
4. WHEN the amount debited from the ledger and the amount sent to the provider are computed, THEN they SHALL derive from a single validated integer value, so they cannot round in opposite directions.
5. WHEN the existing tier logic is retained, THEN the ₦20,000 no-BVN and ₦3,000,000 BVN-daily behaviour SHALL be unchanged for legitimate customers.
6. WHEN a withdrawal is within all limits, THEN it SHALL succeed exactly as before.

### R7 — An equity order cannot be funded by another order's money

**Story:** As a customer, my order must be filled with my money, and my sale proceeds must reach me.

**Finding:** `P3-H-01`

**Acceptance criteria**
1. WHEN two equity operations that touch the custody wallet run concurrently, THEN they SHALL be serialised, and the second SHALL wait or fail cleanly rather than proceed.
2. WHEN the serialisation lease cannot be acquired or its backing store errors, THEN the operation SHALL fail **closed**. It SHALL NOT proceed unserialised.
3. WHEN the lease is held, THEN it SHALL cover the whole order including both legs, not be released between them.
4. WHEN an order's received amount is determined, THEN it SHALL be attributable to that order specifically. A whole-wallet balance delta SHALL NOT be the sole source of truth where a receipt-scoped alternative exists.
5. WHEN two orders are submitted simultaneously in a test, THEN neither SHALL be credited with the other's output, and this SHALL be proven by automated test rather than inspection.
6. WHEN serialisation is added, THEN it SHALL cover every path that signs with the custody key — off-ramp sends, pool supply and withdrawal, admin supply-idle, equity swaps, GetEquity and HyperFX — not only the equity path (`P3-H-11`).

### R8 — No equity order can be stranded

**Story:** As a customer, if something fails mid-order I must end up either with my shares or with my money, never neither.

**Findings:** `P3-H-03`, `P3-H-04`

**Acceptance criteria**
1. WHEN an order or sale remains `pending` beyond a defined window, THEN a reconciler SHALL detect it, determine the true on-chain outcome, and settle or refund accordingly.
2. WHEN the reconciler resolves a row, THEN it SHALL use a guarded claim so that concurrent runs cannot double-settle or double-refund — following the pattern already proven in `cron/reconcile-withdrawals`.
3. WHEN the serverless or host process dies at any point in an order, THEN no customer SHALL be left debited without shares, and no customer SHALL be left with shares removed but uncredited.
4. WHEN the route completes an order in the background, THEN the execution context SHALL declare an explicit maximum duration, and order state SHALL be durable enough to resume or reconcile after process death.
5. WHEN the first leg succeeds and the second fails, THEN the resulting position SHALL be recorded such that the ledger does not claim assets that are not held. A database-only refund that leaves custody holding a different asset SHALL be detected and reported rather than silently absorbed.
6. WHEN the reconciler runs, THEN its authorization SHALL fail closed in the same manner as existing cron routes.
7. WHEN stranded rows found during R2 forensics are resolved, THEN each SHALL be settled or refunded, and affected customers SHALL be made whole.

### R9 — Defence in depth on the data layer

**Story:** As the business, the ledger should resist corruption even if an authorization control is missed.

**Findings:** `P3-M-01`, `P3-M-19`, `P3-API-08`

**Acceptance criteria**
1. WHEN any `SECURITY DEFINER` function is created or replaced, THEN it SHALL set an explicit `search_path`.
2. WHEN a balance column would go negative, THEN the write SHALL fail rather than store a negative balance.
3. WHEN a provider reference or transaction reference is reused, THEN a uniqueness constraint SHALL prevent a second credit for the same underlying event.
4. WHEN uniqueness constraints are added, THEN existing data SHALL first be checked for violations, and any found SHALL be reported before the constraint is applied.

### R10 — Every closed hole is proven closed

**Story:** As the reviewer, I need evidence rather than assertion, because this work is what a customer's balance now depends on.

**Acceptance criteria**
1. WHEN the adversarial test suite runs against a staging environment configured like production, THEN each of the following SHALL fail: writing one's own balance; setting one's own `kyc_status`; maturing one's own lock; calling each credit-side function directly; calling `place_equity_order` / `place_equity_sell` / `create_loan` / `repay_loan` directly; reading `platform_fees` or the revenue views as a client; modifying `deposit_scan_state`; exceeding the hard withdrawal ceiling with self-set `kyc_status='verified'`.
2. WHEN the concurrency test runs, THEN two simultaneous equity orders SHALL NOT be attributed each other's output, and two simultaneous withdrawals against one balance SHALL NOT both succeed.
3. WHEN the reconciler test runs, THEN an order interrupted mid-flight SHALL be resolved to either filled or refunded, never left pending.
4. WHEN the full existing product surface is exercised on staging, THEN every money path SHALL still work: deposit, withdrawal, savings lock and release, goal contribution, esusu contribution and payout, equity buy and sell, loan borrow and repay, admin dashboard.
5. WHEN the migration is prepared, THEN a rollback path SHALL exist and SHALL be tested on staging before production application.
6. WHEN Gate 1 is assessed, THEN the R2 forensics summary SHALL accompany the test results, so the reviewer sees both what was closed and what it already cost.

---

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Production schema differs from the repository, so the migration is wrong or destructive | R1 blocks all work until the diff is done and resolved |
| Revoking EXECUTE breaks a server call site using a user session rather than service role | R4.5 requires every call site be reviewed and migrated first; R10.4 exercises the full surface on staging |
| A client write path not found in reconnaissance breaks | Reconnaissance re-run against production in R1; staging exercise in R10.4; rollback ready per R10.5 |
| Serialising custody serialises too much and slows or deadlocks money paths | Lease has a bounded TTL; R7 requires clean failure rather than indefinite blocking; load-tested in Week 4 |
| Fail-closed serialisation causes user-visible failures during a backing-store outage | Accepted deliberately — a failed order is recoverable, a cross-attributed order is not. Surfaced as a clear error, not a silent stall |
| Two tracks in one week overruns | Flagged in the audit; Week 2 application items are the declared slip. Track A's migration is small; Track B's reconciler is the larger build |
| Making customers whole requires funds not budgeted | R2 quantifies before we commit; the figure goes to leadership with the Gate 1 summary |

## 6. Non-goals

- No new product capability.
- No contract changes — the vault lock bypass (`P3-C-04`) is Critical but is Week 3, because it requires a redeploy and value at risk on-chain is currently low.
- No refactoring for its own sake. Dead code is removed only where it represents a broken or dangerous path (R3.6).
- No change to the equity feature's availability. Whether to disable thin-pool symbols is a leadership decision recorded in the audit, not a requirement here.

## 7. Open questions

1. **What is the interim hard ceiling value?** Leadership approved a cap in principle. R6 needs the number, and whether it applies per transaction, per day, or both.
2. **Do we disable the five thin-pool symbols during Week 1?** Depends on resolving the $5k-versus-$1M pool-depth contradiction, which is an R1 task. If the low figure is correct, disabling them costs nothing and removes exposure until Week 2's fair-value floor.
3. **Is `USSD_ENABLED` set in production?** If yes, `P3-C-05` becomes a Week 1 Critical and this spec grows a requirement.
4. **What is the remediation policy for affected customers** found in R2 — automatic make-whole, case-by-case, or a threshold?

---

*Requirements only. No design decisions or implementation detail here by intent — those follow in `design.md` once these are agreed.*
