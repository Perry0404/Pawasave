# Week 1 — Critical Remediation: Tasks

**Spec:** `week1-critical-remediation`
**Requirements:** `requirements.md` · **Design:** `design.md`

Phase 0 blocks everything. After Phase 1, Track A and Track B run in parallel. Phase 5 is the gate.

Ordering constraints that matter:
- Tasks 16 to 19 must land before task 20, or those features break
- Task 18 must land with task 17, or the admin revenue page goes blank
- Task 13 must be verified before task 20, it is the only rollback path
- Tasks 11 and 12 block all of Phase 5

## Log

**07 Sep, unplanned incident, closed.** Phase 0 introspection found RLS **disabled** on
`wallets` and `profiles` in production, so their policies were not enforced and `anon`
held full CRUD on both. Closed by `HOTFIX-rls-wallets-profiles.sql`, five checks passed.
Enabling RLS surfaced an unrelated pre-existing bug, `useAuth` had no `.catch()` on
`getUser()`, which hung the home screen. Fixed in commit `c4dc78e`, deployed and verified
in the served bundle. Signup was never broken: `handle_new_user` runs as `postgres` which
has `BYPASSRLS`, and all 44 users have their rows. Balance reconciliation found no forgery.

Audit updated to revision 3. `P3-C-01` escalated, `P3-M-02` corrected.

## Hosting context

Production runs on **Coolify** on a Hetzner box, Cloudflare in front, Docker build from `frontend/Dockerfile`, Supabase managed. **Vercel is no longer in use.** A move to Contabo is planned and has been deferred until after this remediation, so the host is stable for the duration.

There is **no staging environment**. Tasks 11 and 12 create one.

---

## Phase 0 — Ground truth and environment (blocks all other work)

- [ ] 1. Capture the live production schema
  - Dump schema-only with `pg_dump`, plus a full inventory of function definitions via `pg_get_functiondef`, all table and column grants, all RLS policies, and all view definitions
  - Store the raw output outside the repo, it contains structural detail we do not want committed casually
  - _Requirements: R1.1_

- [ ] 2. Diff production against the 55 migration files and record every discrepancy
  - Produce a written diff report listing anything present in production but absent from the repo, and anything the repo defines differently
  - Determine which of the three `007` files and which of the two `017` files is live, since two define `record_platform_fee` differently and only one carries REVOKEs
  - Flag any discrepancy touching `wallets`, `profiles`, `savings_locks`, function grants or RLS as blocking
  - _Requirements: R1.1, R1.2, R1.5_

- [ ] 3. Commit the recovered baseline as `073_schema_baseline_recovered.sql`
  - Number has moved three times today as teammates shipped 069 through 072. **Claim the number at the moment of writing, not in advance**, and re-take the snapshot immediately before task 21 rather than days ahead. The schema is moving under us
  - Include the eight functions that have no source in the repo: `try_acquire_lock`, `release_lock`, `pin_lock_status`, `record_pin_attempt`, `place_getequity_order`, `settle_getequity_order`, `create_ajo_invite`, `claim_ajo_invite`
  - Mark the file clearly as a documentation baseline, not something to re-run against production
  - Read `pin_lock_status` and `record_pin_attempt` closely and write down their semantics. The PIN lockout depends on them and task 20 must not break them
  - _Requirements: R1.1, R4.4_

- [x] 4. Confirm production environment state
  - **`USSD_ENABLED` is not set in the environment**, so the USSD route returns early and `P3-C-05` stays dormant. No eleventh requirement needed. It remains one env var away from a Critical, so the hard guard in task 21's scope still matters before anyone enables it
  - `EQUITY_ENABLED` and `HYPERFX_ENABLED` confirmed on. All ten symbols live, and task 6 showed that is fine since every pool is deep
  - Still unchecked: whether the Cloudflare WAF rate limit on `/api/*` is configured. Minor, it would partially offset the middleware limiter failing open
  - _Requirements: R1.3_

- [x] 5. Restore a working local environment and run the contract test suite
  - **85 passing, 0 failing.** Better than the tracker's claim of 75, tests were added since it was written
  - npm registry was blocked earlier in the session and is now reachable, so local build and test work from here
  - Note the suite still has no coverage for the items in `P3-M-13`: `PawasaveLendStrategy` against a real pool, bad debt, the lock transfer bypass, or strategy migration. 85 green does not mean those are safe, it means what is tested passes
  - _Requirements: R1.4_

- [x] 6. Resolve the pool depth contradiction
  - Done via `probe-pool-depth.mjs`, quoting real trades against both venues at $10, $100, $1k and $3k
  - **All ten pools are deep.** Price impact is under 0.2% at $3,000 for every symbol. The `:52-58` "$1M+, flat to $3k" comment is correct and the `:104-110` "~$5k" note is wrong or was measuring Uniswap V3 only rather than Aerodrome Slipstream
  - **Consequences:** do not disable the five so-called thin symbols, they are fine. `P3-H-02`, the missing buy-side fair-value floor, drops from High to Medium since there is no thin pool to dump into at realistic size. The per-order ceiling is still wanted as a blast-radius control but not for price impact
  - Fix the stale comment at `:104-110` so nobody re-derives the wrong conclusion
  - _Requirements: R1 supporting, design section 9 item 2_

- [x] 7. Re-verify the client write reconnaissance against production
  - Confirmed. Production policies match the repo, and no live client path writes to these tables. The only client write was `updateTransactionPin`, which has no callers
  - _Requirements: R3.4, design section 3.1_

- [x] 8. Delete the dead Vercel configuration
  - `frontend/vercel.json` removed. Also repointed the stale `vercel.json` references in the seven cron route comments and `OPERATIONS_GUIDE.md` at `ops/cron/crontab`, since they pointed at a file that no longer exists
  - Closes `P3-M-18`
  - _Requirements: supporting, audit P3-M-18_

- [x] 9. Correct `DEPLOY.md`
  - Branch corrected to the real trunk with a warning against deploying `main`. Added a post-cutover status banner. Replaced the "flip DNS back to Vercel" rollback with the actual deploy trigger, the chunk-hash verification, the 3.5 minute build time, and a note that Coolify rollback is still untested
  - _Requirements: supporting, audit P3-OPS-01_

- [ ] 10. Verify the deploy rollback path actually works
  - Confirm Coolify can redeploy the previous image and that doing so restores a working app. Time it
  - This is the only way back if task 20 goes wrong, so it is verified before task 20, not assumed
  - _Requirements: R10.5_

- [x] 11. Stand up a staging Supabase project
  - **Full runbook in `SETUP-staging.md`.** Key decision recorded there: clone production's schema with `pg_dump --schema-only`, do **not** build staging by running the 72 migrations. The repo diverges from production in both directions, so a migration-built database would be a different database from the one we are protecting
  - Requires resetting the production database password first. Verified safe: nothing in the codebase opens a Postgres connection, no `pg` driver, no `DATABASE_URL`
  - Then reproduce production's RLS and grant posture exactly, and seed users covering every withdrawal tier
  - _Requirements: R10.1_

- [ ] 12. Stand up a staging app tier
  - **Runbook in `SETUP-staging.md`.** Railway from the same `frontend/Dockerfile`, root directory `frontend`, branch is the trunk not `main`
  - All money flags off, a freshly generated throwaway custody key holding nothing, no crontab installed
  - Note `GETEQUITY_ENABLED` must be left **empty** rather than `false`, it is read as a truthy check so the string `"false"` would enable it
  - _Requirements: R10.1, R10.4_

- [x] 12.1 Verify staging actually mirrors production
  - Run `phase0-introspection.sql` against staging and diff section by section against the production run
  - **If staging is more locked down than production, the adversarial suite passes for the wrong reason and tells us nothing.** This is the main failure mode of the whole exercise
  - _Requirements: R10.1_

---

## Phase 1 — Forensics (read-only, after Phase 0)

- [ ] 13. Quantify stranded equity orders and sales
  - List every `equity_orders` and `equity_sales` row pending beyond the settlement window, with customer, amount, shares, cost basis removed, and age
  - Report total customer money in limbo as a single figure
  - _Requirements: R2.1, R2.2, R2.7_

- [ ] 14. Detect cross-order contamination
  - Compute implied FX rate for every filled order and sale, identify outliers against `usd_ngn_rate`
  - Flag any two orders created within the four minute contamination window
  - _Requirements: R2.3, R2.7_

- [ ] 15. Reconcile the equity ledger against the chain
  - Sum `portfolio_holdings.shares` per symbol, compare against the omnibus custody wallet's actual on-chain token balances
  - Report shortfall per symbol and in aggregate. This is the realised cost of `P3-H-01` and `P3-H-04`
  - _Requirements: R2.4, R2.7_

- [x] 16. Reconcile customer balances against transaction history
  - Done via `RECONCILE-balances.sql`. **No evidence of forgery.** Positive variance was the signal and no account shows it. 44 users, 4 funded wallets, ₦3,331 total customer money
  - One negative variance on the team's own test account, explained in `DRILLDOWN-flagged-wallet.sql`: withdrawals populate `amount_kobo` and leave `amount_usdc_micro` at zero, so they were invisible on the debit side. Not missing money
  - Still outstanding: the written summary covering tasks 13 to 16, once 13 to 15 are run
  - _Requirements: R2.5, R2.6_

---

## Track A — Data layer (parallel with Track B)

- [ ] 17. Move Category 2 functions behind server routes
  - Nine functions currently callable from the browser must not be: `allocate_cngn_pool`, `esusu_contribute_crypto`, `record_lock_forfeiture`, `record_goal_forfeiture`, `create_ajo_invite`, `proxy_transfer`, `register_proxy_member`, `get_proxy_transfers`, `get_proxy_member_for_user`
  - Add a server route per function or group, authenticated and validated, using a service-role client
  - Switch every client call site to `fetch`. This must land before task 20 or these features break
  - _Requirements: R4.3, R4.5, design section D1_

- [ ] 18. Recreate the six views with `security_invoker = true`
  - `revenue_summary_daily`, `revenue_summary_monthly`, `revenue_by_type`, `platform_metrics`, `offramp_audit`, `yield_summary`
  - _Requirements: R5.3_

- [ ] 19. Convert `/admin/revenue` to a server route behind admin auth
  - Must ship with task 18. The views read `platform_fees`, which is RLS deny-all, so adding `security_invoker` empties the page unless it reads through the service role
  - Verify every figure the page displayed before still displays
  - _Requirements: R5.4, R5.5, design section D3_

- [ ] 20. Delete dead and broken paths
  - `updateTransactionPin` in `hooks/use-data.ts`, no callers, and migration 045's trigger would reject it
  - The four already-revoked admin RPC calls in `admin-view.tsx`: `admin_fee_summary`, `admin_recent_fees`, `admin_tx_volume`, `admin_user_stats`
  - _Requirements: R3.6, design section D1 Category 3_

- [x] 20.1 Derive the allow-list from the call sites, and take the balance-moving RPCs off the session
  - Added because task 21.4 named fourteen functions, and a mechanical scan of every `.rpc()` call found eleven more reached with the user's session from server routes. Revoking to fourteen would have broken off-ramp refunds, loans and equity orders
  - `derive-rpc-allowlist.py` classifies every call site as browser, user session, or service role. The fourteen it derives for Category 1 match the audit's manual list exactly, which is the cross-check
  - Five of the eleven were value-moving and had no business on a session: `credit_wallet`, `debit_wallet`, `withdraw_cngn_pool`, `record_platform_fee`, `set_deposit_address`. Their only authorization is `auth.uid() = p_user_id`, which permits crediting yourself, so the grant they force is itself the hole. Moved to a service-role client that throws rather than falling back
  - Final allow-list is twenty: the fourteen, plus six order and loan functions that genuinely need `auth.uid()`
  - _Requirements: R4.1, R4.2, prerequisite for 21.4_

- [ ] 21. Write the authorization migration
  - One migration, one logical state transition. Splitting it creates windows where policies are dropped but grants are not yet tightened
  - _Requirements: R3, R4, R5, R9, design sections D1, D2, D3, D5, D9_

- [x] 21.1 Drop the client UPDATE policy on `wallets`
  - No legitimate client write exists, confirmed in task 7
  - _Requirements: R3.1_

- [x] 21.2 Extend migration 045's trigger on `profiles`
  - One trigger guarding `transaction_pin_hash`, `kyc_status`, `kyc_type`, `kyc_id_hash`, `kyc_verified_at` and the `strails_*` columns against writes under the `authenticated` role
  - Leave display name and preferences client-writable
  - _Requirements: R3.2, R3.5_

- [x] 21.3 Add an equivalent trigger on `savings_locks`
  - Guard `status`, `unlocks_at`, `amount_usdc_micro`, `projected_interest_micro`, `accrued_yield_micro`
  - _Requirements: R3.3, R3.5_

- [x] 21.4 Revoke execute from PUBLIC, anon and authenticated, then grant back the allow-list
  - Allow-list is the fourteen Category 1 functions only, each with a one line comment saying why it is client-callable
  - Verify no credit-side function appears in the list, and that `pin_lock_status` and `record_pin_attempt` retain whatever access their call sites need
  - Applied as 077/078. Anon-callable went 69 to 1, `is_group_member`, which five RLS policies need. Authenticated-callable is 30, and the two `record_*_forfeiture` functions left that set when 079 made them owner-scoped, which is correct since only server code calls them
  - _Requirements: R4.1, R4.2_

- [x] 21.5 Enable RLS on the four exposed tables
  - `revenue_journal`, `deposit_scan_state` and `proxy_transfers` deny client access entirely. `fixed_savings_rates` allows client SELECT only, the app displays rates
  - RLS on all four, and the first three carry zero policies so they deny everything
  - Finishing the leftover grants turned up a bigger thing, handled in 082. `anon` and `authenticated` held TRUNCATE on all 40 public tables including `wallets` and `transactions`, and RLS does not filter TRUNCATE, so no policy work this week covered it. Not reachable through PostgREST, but removed
  - Worse, `CREATE FUNCTION` grants EXECUTE to PUBLIC, so every new RPC came out anon-callable and would have quietly undone 21.4. `ALTER DEFAULT PRIVILEGES` does not fix this, revoking from PUBLIC and from anon both apply and change nothing. An event trigger on `ddl_command_end` does
  - _Requirements: R5.1, R5.2_

- [x] 21.6 Add `SET search_path` to every SECURITY DEFINER function
  - Applied during the rewrite from task 3's recovered definitions
  - _Requirements: R9.1_

- [x] 21.7 Add non-negativity constraints and uniqueness on provider references
  - Scan for existing violations first and report them before applying. A pre-existing negative balance or duplicate reference is itself a finding
  - Pre-scan was clean: 0 negative balances, 0 negative amounts, 0 duplicate references. There was no unique index on `transactions.reference`
  - This stopped being hygiene once staging showed it was a live cap bypass. A signed-in user inserting `type 'withdrawal', status 'completed', amount_kobo -500000000000` made the app's 24 hour total read -5,000,000,000 naira, so the ₦3,000,000 cap passed anything. Applied as 081 and re-verified on production: the insert now trips `transactions_amount_kobo_nonneg`
  - _Requirements: R9.2, R9.3, R9.4_

- [ ] 21.8 Write and test the paired rollback script
  - Restores prior policies and grants from task 1's captured state. Tested on staging before production application
  - _Requirements: R10.5_

- [x] 22. Add the hard withdrawal ceiling and amount validation
  - Ceiling evaluated before the existing tier logic and consulting no customer-writable field
  - Env configured so it can be tuned without a deploy, and logged on rejection so the active value is observable
  - Validate a single integer kobo value at the entry point, derive the ledger row and the on-chain send from it so they cannot round in opposite directions
  - Existing ₦20,000 and ₦3,000,000 tier behaviour unchanged for legitimate customers
  - Deployed as 815f0cc. `HARD_WITHDRAWAL_CEILING_NGN` set to 5,000,000 in Coolify, above the BVN tier so no real customer moves
  - _Requirements: R6.1 to R6.6_

---

### Follow-on findings from the 080 sweep (11 Sep)

Migration 080 closed the six tables that mattered most. Sweeping the remaining 28 that grant
writes to `authenticated` showed most are safe: only 11 write policies exist in the whole
schema, and the other tables have grants gated by SELECT-only policies, so RLS denies the write.
`platform_settings` and `crypto_deposits` are in that safe group, which matters because
`platform_settings` holds `admin_emails`.

What a signed-in user can still write, in priority order:

- [ ] F1. `transactions` INSERT, policy "Users insert own txs", check (auth.uid() = user_id)
  - The ledger is client-authored. `hooks/use-data.ts` writes rows from the browser in six
    places, so the policy cannot go until those move server-side
  - Until then the ledger is not the trustworthy side of a reconciliation, which several checks
    this week assumed it was
  - Highest priority of what remains

- [ ] F2. `esusu_contributions` INSERT, check verifies m.user_id = auth.uid()
  - A member can write a contribution row for their own member id with no money moving. They
    cannot forge other members' rows, so this is not a full fake cycle
  - process_esusu_payout counts DISTINCT member_id for the cycle and pays out when that reaches
    the active member count, so one member can take a free ride: collect the pot on their turn
    while everyone else pays honestly
  - Contributions should only be written by esusu_contribute and esusu_contribute_crypto under
    the service role

- [ ] F3. `esusu_groups` ALL, using (owner_id = auth.uid())
  - The owner has full write on their own group including current_cycle and
    contribution_amount_kobo. Rewinding current_cycle could re-trigger a payout

- [ ] F4. `esusu_crypto_deposits` INSERT, check (user_id = auth.uid())
  - Same shape as F2. Confirm whether anything credits from these rows before judging severity

- [ ] F5. `emergency_requests` and `emergency_votes` INSERT, both scoped to the caller
  - Self-request plus self-vote. Check whether the vote threshold counts distinct voters and
    whether one member can satisfy it alone

`split_rules` ALL and `savings_goals` INSERT are fine. Goal inserts are column-guarded by the
trigger 080 added, and split rules carry no value.


---

## Track B — Equity path (parallel with Track A)

> **Re-scoped 07 Sep.** A teammate shipped `c4290c0` and `1feb522`, which close the
> **sell** side of the two-leg problem: an `EquitySellCngnPending` error parks the sale as
> `settling` with the USDC recorded and the shares deliberately not restored, the sell
> amount is clamped to the actual custody balance, and `api/cron/equity-sell-reconcile`
> retries the cNGN leg and credits. Migration 072 adds the `settling` status and makes
> `settle_equity_sell` restore shares only from `pending`.
>
> That closes the sell half of `P3-H-03` and `P3-H-04`, and the sell symptom of `P3-M-16`.
> Do not rebuild it. What remains is the **buy** side, custody serialisation, attribution,
> and divergence recording.
>
> **Their fix also makes `P3-H-01` more likely, not less.** The reconciler calls
> `convertUsdcToCngn` from a cron every 10 minutes, so there is now a third concurrent
> actor on the shared custody wallet alongside user buys and sells, and it still measures
> a whole-wallet balance delta. Tasks 24 to 28 went up in priority, not down.

- [ ] 23. Add durable order state columns to `equity_orders`
  - Additive only: which leg completed, HyperFX order reference, swap transaction hash, attempt counter, `started_at`
  - `equity_sales` already got the equivalent through migration 072's `settling` status plus the recorded `usdc_micro`. Mirror that shape on the buy side rather than inventing a different one
  - _Requirements: R8.4_

- [x] 24. Create the custody lease table and RPCs
  - Fencing token so release only succeeds for the current holder, TTL with refresh, named scopes
  - Scopes: `custody:signer` for anything signing with the custody key, `custody:pool-supply` for pool operations
  - _Requirements: R7.1, R7.2, design section D5_

- [x] 25. Write `custody-lease.ts`
  - Acquire returns an opaque token, release is a no-op without a matching token
  - Fails closed on any error. Bounded wait with jitter then clean failure, never an unbounded block on a money path
  - TTL refresh for long operations. HyperFX alone can run 195 seconds against the old fixed 180 second TTL
  - Keep `acquireSupplyLock` as a thin wrapper over `custody:pool-supply` so existing call sites keep working
  - _Requirements: R7.1, R7.2, R7.3_

- [x] 26. Wrap every custody signing path in the lease
  - Off-ramp `sendCngn`, `supplyToLend`, `withdrawFromLend`, `admin/supply-idle`, equity swaps, GetEquity, HyperFX
  - Anything left outside can still collide on nonce
  - _Requirements: R7.6_

- [x] 27. Hold the lease across both equity legs
  - `equity-broker.ts:363` currently releases after leg 1. It must not, no other custody operation may run while an order is measuring balance deltas
  - _Requirements: R7.3_

- [x] 28. Replace balance-delta attribution with receipt parsing where possible
  - Parse `Transfer` and `Swap` events from the specific swap receipt rather than differencing wallet balances
  - HyperFX's solver fill has no receipt we control, so serialisation remains the only defence on that leg. Record that asymmetry in the code
  - _Requirements: R7.4, design section D6_

- [x] 29. Build the **buy-side** reconciler
  - The sell side is done. `equity_orders` stuck in `pending` still has nothing watching it
  - Apply the same shape their sell fix uses: a buy is cNGN→USDC then USDC→stock, so leg 1 succeeding while leg 2 fails must park the order rather than refund in the database while the cNGN is already gone. That is the buy mirror of `EquitySellCngnPending`
  - Mirror the guarded-claim `resolve()` pattern from `cron/reconcile-withdrawals`, already proven double-refund-proof here
  - Resolution: stock received means settle filled, nothing left custody means refund, USDC held with no stock means park and retry, ambiguous means leave pending and alert
  - Never guess. An ambiguous row increments the attempt counter and waits
  - _Requirements: R8.1, R8.2, R8.3, R8.5_

- [x] 29.1 Add an attempt counter and escalation to the **sell** reconciler
  - Theirs increments a local `stillPending` and logs a warning. A sale that can never fill loops silently every 10 minutes with nothing escalating
  - Persist an attempt count and surface a sale stuck beyond a threshold, so it reaches a human instead of retrying forever
  - _Requirements: R8.1, R8.5_

- [x] 29.2 Verify custody still holds the recorded USDC before converting
  - The reconciler passes the stored `usdc_micro` to `convertUsdcToCngn` without checking custody still has it. A concurrent buy can spend it, in which case the conversion either fails or converts someone else's USDC
  - Same clamp-to-actual-balance idea they applied to the stock leg, applied to the USDC leg
  - _Requirements: R7.4, R8.5_

- [x] 30. Add the buy reconciler cron with fail-closed auth
  - Use the existing `checkCronAuth`. Add the schedule to `ops/cron/crontab` and a healthchecks.io check to `cron.env`, following the pattern their sell reconciler already set
  - Declare an explicit `maxDuration` on the equity order routes so background work has a bounded window
  - Copy their `cache: 'no-store'` fetch override. They hit a real Next.js App Router bug where a GET-reading cron caches its first empty response and never sees later rows
  - _Requirements: R8.4, R8.6_

- [x] 31. Record ledger and custody divergence rather than absorbing it
  - When the first leg succeeded and the second failed, make the customer whole and write the divergence to a reconciliation record so the aggregate stays visible
  - _Requirements: R8.5, design section D8_

- [x] 32. Resolve the stranded backlog
  - Forensics found **no stranded buys** and **two stranded sells**, both on the team's own account, so no customer is out of pocket. Sale 6 TSLA at 1.23 USDC and sale 7 NVDA at 0.72 USDC, tokens sold, customer uncredited
  - One real customer, `nnadifavour850`, hit a sell failure and was **correctly restored**, shares and ₦1,000 basis both returned
  - Their `equity-sell-reconcile` cron resolves both stranded sales once deployed. **Deploy plus custody gas is the action, not new code**
  - Contamination check clean: every overlapping order pair was the same user with themselves, and implied FX rates cluster inside ±1.6%. `P3-H-01` has not fired
  - _Requirements: R8.7, R2.6_

- [ ] 32.1 Confirm the two stranded sales actually settle after deploy
  - Re-run `FORENSICS-settling-sales.sql` once the reconciler has had two ticks. Both should reach `filled` with a `cngn_net_micro` and a matching ledger row
  - If they do not, the blocker is almost certainly custody gas or the USDC no longer being there, see task 29.2
  - _Requirements: R8.1, R10.3_

---

## Phase 5 — Gate 1 verification

- [ ] 33. Build a HyperFX stub for staging
  - Real HyperFX cannot be staged. It is an off-chain solver network with no testnet, and a mainnet fork has no solvers
  - The stub fills after a configurable delay, so the contamination window can be opened deliberately. This makes the concurrency test deterministic, which real solvers would not
  - Fork Base mainnet with Anvil for the DEX legs, the B20 pools exist in forked state
  - _Requirements: R10.2, R10.3_

- [ ] 34. Write the adversarial test suite
  - Runs as an ordinary authenticated user against staging using the public anon key, exactly as an attacker would. Every case asserts failure
  - Write own balance, set own `kyc_status`, mature own lock, call each credit-side function directly, call `place_equity_order` and `place_equity_sell` and `create_loan` and `repay_loan` directly, read `platform_fees` and each revenue view, modify `deposit_scan_state`, call `submit_kyc`, exceed the hard ceiling after self-setting `kyc_status`
  - _Requirements: R10.1_

- [ ] 35. Write the concurrency tests
  - Two simultaneous equity orders must not be attributed each other's output, using the task 33 stub to widen the window
  - Two simultaneous withdrawals against one balance must not both succeed
  - _Requirements: R7.5, R10.2_

- [ ] 36. Write the interruption test
  - An order killed mid-flight must be resolved by the reconciler to filled or refunded, never left pending
  - _Requirements: R10.3_

- [ ] 37. Full product regression pass on staging
  - By hand, every money path: deposit, withdrawal, savings lock and release, goal contribution, esusu contribution and payout, equity buy and sell, loan borrow and repay, admin dashboard
  - This is what catches a missing grant. Not optional
  - _Requirements: R3.4, R4.6, R10.4_

- [ ] 38. Assemble the Gate 1 review package
  - Adversarial and concurrency results, the forensics summary from task 16, the ledger and chain reconciliation figure from task 15, and the rollback test result from task 10
  - State plainly what staging could not prove, chiefly the live HyperFX integration
  - _Requirements: R10.6_

---

## Notes

**Blocked on answers.** Task 22 needs the interim ceiling value. Task 32 needs the customer remediation policy. Task 4 may add scope if `USSD_ENABLED` is on. Task 6 informs the thin-symbol decision.

**Staging fidelity limit.** R10.1 asks for staging "configured like production". That holds for the database, which is where most of the verification lives. It cannot hold for the HyperFX leg. After Gate 1 we will have proven the serialisation logic correct, not that the live integration behaves. The latter needs one small real transaction in production, which `ops/env-checklist.md` §8 already recommends and which appears never to have been done since the batch of six symbols was enabled.

**Scope risk.** Task 17 is the largest hidden cost in Track A, nine functions each needing a route and a client change. If task 2 shows the 046 to 061 gap contains tables or policies as well as functions, scope grows and the estimate gets revised rather than absorbed.

**Deferred by correction.** The BVN hash salt item is out of Week 1. `ops/env-checklist.md` establishes that `BVN_HASH_SALT` was never set in production, so every existing hash used an empty salt. Adding a salt now breaks matching for every existing customer, and re-hashing needs raw BVNs which are not stored. It needs a versioned forward-only design, not a one line fix. The audit entry has been corrected.

**Not in this spec.** The vault lock bypass `P3-C-04` is Critical but sits in Week 3, it needs a contract redeploy and on-chain value at risk is currently low. Buy-side fair-value floor, HyperFX fill threshold, MAX approval replacement, the residency gate and the admin auth rebuild are Week 2.

---

### F6. Withdrawals were down for four days on an exhausted RPC key (found 12 Sep)

Found while checking a "payment service unavailable" report. Not a security finding, but it cost
more customer trust than anything else in this spec.

The Alchemy plan hit its monthly cap and returned 429 to every call. `baseRpcUrls()` appends
public fallbacks so reads degraded quietly, but `getWriteProvider()` returned one endpoint with
no fallback, and the last step of a withdrawal is custody broadcasting the cNGN transfer. So
every payout failed from 8 Sep 10:24 UTC while the app stayed green. Ten attempts across three
users, ₦4,012. All refunds worked, both affected wallets reconcile to the ledger exactly.

Three things kept it hidden for four days, and each is now fixed:

- No fallback on the write path. Writes now walk an ordered endpoint list and stick to the first
  that answers, so sequential custody txs still take a monotonic nonce from one source
- The dead endpoint did not error, it hung. ethers looped on "failed to detect network, retry in
  1s" forever, so nothing threw and calls never returned. Attempts are now bounded and the
  network is pinned so ethers stops probing
- Nothing recorded why a withdrawal failed. The user-facing string is a deliberate catch-all and
  the real error only reached `console.error`. Forty-eight failed off-ramps carry no reason.
  `markTxFailed` now writes it to the row

Verified in production after deploy: probe spam went 283 of 296 log lines to 0, and the failover
fires for real, Alchemy timing out at 12s then moving to mainnet.base.org.

Separate bug found alongside it: our bank list comes from Flint or Paystack, which do not share a
code namespace with Flipeet. Palmpay 999991 is unroutable there while OPay 100004 resolves. The
destination is now checked before any debit.

**Still open, needs a billing decision.** `alchemy_getAssetTransfers` is Alchemy-only by design
and has no fallback, so `scan-deposits` is still failing with 429. Incoming deposits are not
being detected automatically until the quota is restored or the plan is upgraded. Free-tier
`eth_getLogs` caps at a 10 block range, so a public-RPC fallback is not a drop-in substitute.
