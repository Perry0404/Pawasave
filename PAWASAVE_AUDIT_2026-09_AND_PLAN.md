# PawaSave — End-to-End Security Audit & 4-Week Remediation Plan

**audit date:** 5 September 2026
**the branch audited:** `audit-v2-remediation-and-flint-onramp` @ `0796523` — **the actually-deployed trunk**
**full scope:** Solidity contracts · Next.js application & 50 API routes · Supabase data/authorization layer · tokenized-equity & HyperFX subsystem · Strails identity/on-ramp · custody & key handling · deployment and operations
**prior work i found done :** Extends Audit v1 (40 findings) and v2 (43 findings), both of which shipped real remediation. This pass covers ground neither examined.
**so, current status:** For review and approval of the plan in Section 6.

> **Revision 3 — 5 Sept, production schema inspected.** Phase 0 introspection against the live database found something worse than anything in revisions 1 or 2. **Row level security is disabled on `wallets` and `profiles` in production.** Both carry four policies each, but policies are not enforced when RLS is off, and `anon` holds SELECT, UPDATE, INSERT and DELETE on both. Since the anon key ships in the client bundle, every customer balance, deposit address, phone number, BVN hash, KYC status and PIN hash is currently readable and writable by anyone on the internet, with no login and no restriction to their own row. A hotfix is at `.kiro/specs/week1-critical-remediation/HOTFIX-rls-wallets-profiles.sql`. Two audit findings are corrected below: `P3-C-01` was understated, and `P3-M-02` was wrong about which tables lack RLS.
>
> **Revision 2 — 5 Sept, later same day.** Two answers came back from leadership and one of them changes the severities materially: **the tokenized-stocks feature is confirmed live in production.** Three findings previously rated High are now Critical, the Week 1/Week 2 sequencing has changed, and a new Section 4.0 lists what should happen today. The withdrawal cap is approved. Nigeria eligibility has been confirmed informally; the residency-blocking gap it does not cover is noted in 4.2.

---

## 1. Executive summary

So far, PawaSave has built the genuinely hard part. Naira in and naira out through a live provider, per-user on-chain deposit addresses with automated crediting and sweeping, a deployed naira-denominated lending pool, an ERC-4626 savings vault, a BVN identity rail issuing real virtual bank accounts, USSD access for feature phones, and, most recently, tokenized US equity investing routed through an intent-solver network. Very few teams in this market get the fiat ramp working at all. That asset is real and it is worth protecting.

Two prior security passes shipped really meaningful fixes, and the engineering care in this codebase is visible and above average,from fail-closed cron authorization, on-chain-verified withdrawal reconciliation, guarded-claim idempotency on refunds, durable pre-send settlement markers, correct integer money units throughout the schema, and honest remediation trackers. The problems below are absolutely not the product of carelessness.

They are the product of two structural gaps.

**firstly: the security boundary was never audited.** ... both prior passes scoped the contracts and the API routes. In a Supabase architecture the _database_ is the access-control layer, so basically the browser talks to Postgres directly using a key that is public by design, and RLS policies plus function grants are the only thing standing between a logged-in user and every table. That layer has never been reviewed, and it is where a good chunk of the Critical findings are.

**secondly: the codebase outgrew its verification.** Since june the shipped code has roughly doubled, covering 25 API routes to 50, 28 migrations to 55, 2,600 lines of server libraries to about 5,400. The test suite grew from 6 files to 7. New money-moving subsystems (equities, loans, USSD, HyperFX) have **zero automated tests** and no reconciliation for stranded state.

### The headline finding

As written in the repository, the row-level security policy on the `wallets` table permits any authenticated user to set their own balance to an arbitrary value from the browser console, then withdraw it as real naira. Verified present at `supabase/migrations/001_initial.sql:33`, and confirmed unchanged across all 55 migrations. The same shape exists on `profiles` (self-verify KYC) and `savings_locks` (self-mature a fixed deposit).

Based on my findings, the supporting problem is pretty much as serious: of 79 privileged database functions, exactly **13 are revoked** from public execution, and **none** of them cover `credit_wallet`, `credit_crypto_deposit`, `distribute_vault_yield`, `debit_wallet` or `allocate_cngn_pool`. Postgres grants EXECUTE to PUBLIC by default, so those are reachable from any browser. `credit_wallet`'s only guard rejects callers whose `auth.uid()` differs from the target user which means passing your own id satisfies it. It is a self-service mint.

### Scale, for proportion

Established in revision 3 from production, and missing from earlier revisions:

| | |
|---|---|
| Registered users | **44** |
| Wallets holding any money | **4** |
| Total customer money in the system | **₦3,331** |

This does not reduce the severity of any finding. An unauthenticated write path to every
balance is as serious whatever the balances are, and the equity feature moves money into
foreign securities regardless of headcount. But it does mean the remediation is happening
before scale rather than after it, which is the cheapest possible time, and that any
notification obligation concerns 44 records rather than tens of thousands.

### Where the risk actually sits

|                     | On-chain contracts                    | Off-chain custodial ledger |
| ------------------- | ------------------------------------- | -------------------------- |
| Value at risk today | Low, the pool borrowing posture is ~zero | **Real customer money**    |
| Reviewed before     | Twice                                 | **Never**                  |
| Cost to fix now     | Low (redeploy is cheap pre-TVL)       | Low (one SQL migration)    |

Three months of security effort went into the layer holding almost nothing while the layer holding customer balances went unexamined. Correcting that wpuld be the whole point of Week 1.

### Counts

**so, I'm categorising everything into 8 Critical, 14 High and 21 Medium**, plus operational findings. Every Critical and High was confirmed by reading the responsible source; each is cited to file and line.

Three of those Criticals were rated High in revision 1 and were promoted once the equity feature was confirmed live. Their IDs are unchanged (`P3-H-01`, `P3-H-03`, `P3-H-04`) so earlier references still resolve.

### The distinction that drives the plan

The balance-forgery issue is a **vulnerability** — it needs someone who knows our schema and chooses to use it. Low probability, roughly constant.

The three promoted equity findings are **active malfunctions**. They need no attacker at all. They fire whenever two customers transact near each other in time, or whenever a deploy lands mid-order. Their probability rises with usage, and the feature is live.

So the uncomfortable conclusion: the equity path is more likely to have already lost money than the balance issue is. That is why Section 4.0 exists and why Week 1 now runs two tracks.

### Decisions — status

- **Cap withdrawals during Week 1:** ✅ approved. Note the cap we already have is read from a field customers can edit, so Week 1 is what makes it binding — see `P3-C-03`.
- **Nigeria eligibility for tokenized equities:** confirmed informally via the Base Africa team. Two gaps remain and are engineering-side or legal-side rather than closed — see 4.2, "Residency and jurisdiction".
- **Is the feature live in production:** ✅ answered — yes. This is what drove revision 2.

---

## 2. Correction: what was audited, and why the first pass was wrong

I made an earlier draft of this document audited where i initially audited `main`. **`main` is 109 commits and roughly three months stale**, with it's last commit 18 June 2026. The live trunk is `audit-v2-remediation-and-flint-onramp` (4 September 2026), which is a clean fast-forward descendant containing 173 changed files, +19,769 / −2,021 lines, and four entire product subsystems that do not exist on `main`.

So, the earlier draft has been discarded and this document replaces it entirely. Everything below is verified against the shipped and active branch (I might need to change this branch `audit-v2-remediation-and-flint-onramp` to `main`, for proper prod correlation, I'd need your permission on this)

**This is itself a finding (OPS-01), I want to properly document this here** Three months of production development sits on a branch named after June's audit work, while `main`, which is the branch `ops/DEPLOY.md` instructs operators to deploy, is actually stale. Anyone auditing, onboarding, or deploying from the obvious default gets the wrong code. That's why I'd need your permission to discard the current `main` to a new branch `stale`, and have the current `audit-v2-remediation-and-flint-onramp` renamed as `main`, I'd be creating a staging branch too, `staging`, which would directly push PRs to `main`.

---

## 3. Method and limitations

**Read in full:** all 9 contracts (1,911 lines); all 50 API route handlers; all 55 migrations (6,967 lines); all 7 test files (1,169 lines); the equity/HyperFX/GetEquity/Strails libraries; custody, secrets, deposit, supply-lock and RPC-provider libraries; middleware; the `ops/` self-hosted runner; `strails-relay`; deployment artefacts; and all project documentation.

**Verification standard:** every Critical and High was confirmed by direct source inspection. During verification I corrected two of my own intermediate errors, which were, an RLS enumeration that under-counted because migration 042 uses aligned whitespace (the equity and loans tables **do** have RLS), and a function count that conflated definitions with distinct functions. Both are already properly corrected here.

**we do have three limitations, stating them below:**

1. ~~**The test suite was not executed.**~~ **Resolved in revision 3.** The npm registry was unreachable earlier in the session and is now reachable. The suite runs: **85 passing, 0 failing**, better than the tracker's claimed 75. This does not soften `P3-M-13`, because the untested paths are still untested: `PawasaveLendStrategy` against a real pool, bad debt, the lock transfer bypass, and strategy migration. 85 green means what is covered passes, not that the gaps are safe.
2. **Production database schema could not be inspected.** Migrations are applied by pasting SQL into the Supabase web editor. There is no migration ledger, no CLI config, duplicate numbering at `007` (×3) and `017` (×2), and **16 missing numbers between 045 and 062**. The findings describe the repository; production may differ. Confirming this is Priority 0.
3. **Live chain state was not queried.** Whether the borrowing-block script was ever run, what `totalBorrows()` is, who owns the vault, and whether deployed bytecode matches HEAD are all unverified. Several finding severities depend on these.

**Resolved since revision 1:** the production feature-flag state was previously unknowable from the repository. Leadership has confirmed the tokenized-equity subsystem is **switched on in production**, which is what drove the severity changes in revision 2. `USSD_ENABLED` remains unconfirmed and is the one flag still gating a Critical (`P3-C-05`).

---

## 4. Findings register

**Severity:** Critical = currently exploitable path to fund loss or unbounded balance forgery · High = fund loss given a precondition, or loss of a core product guarantee · Medium = accounting damage, DoS, or material operational risk.

IDs use the `P3-` prefix to avoid collision with the v1 (`FIND-`) and v2 (`V2-`) trackers.

### 4.0 Do these today

The equity feature being live makes three findings active rather than theoretical. Before any remediation is written, we should establish how much has already gone wrong. All of the following is read-only or reversible by an environment change.

**a. Find money currently in limbo.** Read-only:

```sql
-- Stranded buys: customer debited, never settled, never refunded
select id, user_id, symbol, amount_cngn_micro/1e6 as ngn,
       created_at, age(now(), created_at) as stuck_for
from equity_orders
where status = 'pending' and created_at < now() - interval '15 minutes'
order by created_at;

-- Stranded sells: shares AND cost basis already removed, never credited (worse)
select id, user_id, symbol, shares, invested_removed_micro/1e6 as basis_removed,
       created_at, age(now(), created_at) as stuck_for
from equity_sales
where status = 'pending' and created_at < now() - interval '15 minutes'
order by created_at;

-- Total customer money in limbo right now
select
  (select coalesce(sum(amount_cngn_micro),0)/1e6 from equity_orders where status='pending') as buys_ngn,
  (select coalesce(sum(invested_removed_micro),0)/1e6 from equity_sales where status='pending') as sells_basis_ngn;
```

**b. Detect cross-order contamination.** A fill whose implied FX rate is an outlier is the signature of one order having captured another's output (`P3-H-01`). The cluster should sit tightly around `usd_ngn_rate`:

```sql
select id, user_id, symbol, created_at,
       amount_cngn_micro/1e6 as ngn_paid, usdc_micro/1e6 as usdc_got,
       round((amount_cngn_micro::numeric / nullif(usdc_micro,0)), 2) as implied_rate
from equity_orders
where status = 'filled' and usdc_micro > 0
order by implied_rate;

select id, user_id, symbol, shares, created_at,
       usdc_micro/1e6 as usdc_got, cngn_gross_micro/1e6 as ngn_got,
       round((cngn_gross_micro::numeric / nullif(usdc_micro,0)), 2) as implied_rate
from equity_sales
where status = 'filled' and usdc_micro > 0
order by implied_rate desc;
```

Also check for orders created within ~4 minutes of each other — that is the contamination window.

**c. Reconcile the ledger against the chain.** Sum `portfolio_holdings.shares` per symbol and compare against the omnibus custody wallet's actual token balances. If the database claims more shares than we hold, that difference is the realised cost of `P3-H-01` and `P3-H-04`. Needs a short script rather than SQL; it is the single number that tells us how bad this is.

**d. Reduce exposure without a deploy.** `EQUITY_DISABLED_SYMBOLS` is read from the environment per request (`equity-broker.ts:140`), so this takes effect immediately:

```
EQUITY_DISABLED_SYMBOLS=SNDK,SPCX,MSFT,MSTR,TSLA
```

Those five are recorded in our own code at roughly $5k of pool depth. AMZN (~$54.6k) and the four originally verified symbols (AAPL, NVDA, META, GOOGL) are defensible to keep live.

> **Contradiction worth resolving first:** `equity-broker.ts:52-58` states these B20 pools hold "$1M+ each" on Aerodrome Slipstream, while `:104-110` records enable-time depths of ~$5k. Both cannot be true, and which one is decides whether an order ceiling is needed at all. One quoter call settles it.

**e. Add a per-order ceiling.** There is a ₦1,000 floor and no cap. Even ₦200,000 bounds the price-impact exposure while the real fix is built.

### 4.1 Critical

**P3-C-01 Anyone on the internet can set any customer's balance**

**Escalated in revision 3 after inspecting production.** `relrowsecurity` is **false** for both `wallets` and `profiles`, so none of their four policies each is enforced, and `anon` holds SELECT, UPDATE, INSERT and DELETE on both. The anon key is public by design.

The live exposure is therefore unauthenticated and unrestricted, across every customer rather than limited to the caller's own row: balances, deposit addresses, phone numbers, BVN hashes, KYC status and `transaction_pin_hash`. Migration 045's trigger only rejects the `authenticated` role, so the anon path writes PIN hashes through it. Setting a PIN then withdrawing is complete account takeover of any customer.

Enabling RLS restores per-user scoping immediately, since the existing policies are correct for that purpose. That reduces the live exposure to the repository-level finding described next, which the rest of Week 1 closes. Hotfix at `.kiro/specs/week1-critical-remediation/HOTFIX-rls-wallets-profiles.sql`.

*Repository-level finding as originally written:*
`supabase/migrations/001_initial.sql:33`

```sql
create policy "Users update own wallet" on public.wallets
  for update using (auth.uid() = user_id);
```

Scoped by _row_, not by _column_. It authorises any update to a row you own, including every balance column. Confirmed unchanged across all 55 migrations. Exploit is one call from the browser console against the public anon key, then a normal withdrawal, the solvency check reads the forged figure.

_Important note on the fix:_ adding `WITH CHECK` does **not** help. Postgres already defaults `WITH CHECK` to the `USING` expression for UPDATE policies, and `auth.uid() = user_id` holds both before and after the write. The client UPDATE grant must be removed and mutations routed through the `SECURITY DEFINER` RPCs that already exist. If this ships as "we forgot WITH CHECK," the wrong patch ships.

**P3-C-02 66 of 79 privileged database functions are callable from any browser**
`supabase/migrations/007_rpc_auth_checks.sql:19`; REVOKE inventory across all migrations

79 distinct database functions are defined (130 definition sites, since several are redefined via `CREATE OR REPLACE`), nearly all `SECURITY DEFINER`. Exactly **13 are explicitly revoked** from PUBLIC. Postgres grants EXECUTE to PUBLIC by default and `GRANT EXECUTE ... TO service_role` does not remove it. Verified by name: **`credit_wallet`, `debit_wallet`, `credit_crypto_deposit`, `distribute_vault_yield` and `allocate_cngn_pool` are not among the 13.**

The guard pattern is wrong for credit operations:

```sql
IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
  RAISE EXCEPTION 'credit_wallet: unauthorized';
END IF;
```

Passing your own id satisfies it. `credit_crypto_deposit` and `distribute_vault_yield` have **no caller check at all**, the former credits an arbitrary "on-chain deposit" against a fabricated transaction hash; the latter distributes arbitrary yield pro-rata across every active lock.

**P3-C-03 Customers can self-verify KYC and self-mature fixed deposits**
`001_initial.sql:17` (`profiles`) · `004_fees_locks_admin.sql:124` (`savings_locks`)

Same row-scoped flaw. On `profiles`: set `kyc_status = 'verified'`, which now lifts the withdrawal cap entirely and satisfies the equity identity gate. On `savings_locks`: set `status='matured'`, backdate `unlocks_at`, and rewrite `amount_usdc_micro` and `projected_interest_micro` before withdrawing.

_Partial mitigation exists and is good work:_ migration `045_protect_transaction_pin.sql` adds a trigger blocking `transaction_pin_hash` changes made under the `authenticated` role, forcing PIN changes through the server endpoint. That closes the PIN half. The KYC and lock-status halves remain open, the same trigger pattern would close them.

**P3-C-04 Every fixed-term savings lock is escapable in two transactions**
`contracts/PawasaveAutoVault.sol` in `_enforceUnlocked` at :193

Grepped the contract: there is **no `_beforeTokenTransfer` or `_update` override**. `lockedShares` is keyed to the depositor and never moves on transfer. So: `depositFixed(...)` → `pAUTO.transfer(secondWallet, shares)` → `redeem()` from the second wallet, day one. `lockedShares[second] == 0`, so the check passes.

This defeats the entire fixed-savings product and the higher rates justified by it. It also leaves the origin account with `lockedShares > 0` and `balanceOf == 0`, which permanently bricks that account's own withdrawals and makes `releaseMatured()` underflow-revert at maturity. No test attempts a transfer of locked shares. One override closes it.

**P3-C-05 The USSD endpoint is an unauthenticated account-takeover primitive**
`frontend/src/app/api/ussd/route.ts`

Currently dark (`USSD_ENABLED !== 'true'` at :47), that is the only control holding. If enabled without the _optional_ `USSD_GATEWAY_SECRET` (:51-54):

- Identity is the `phoneNumber` field of the POST body (:58). No signature, no IP allowlist. Anyone can impersonate any registered number.
- **A transaction PIN can be created with zero proof of identity** when the user has none (:187-196) and that is the same `transaction_pin_hash` that authorises withdrawals and loans. It is written with the service role, bypassing migration 045's protection.
- **Unlimited PIN brute force.** `verifyPin` at :172 and :199 is called without the `pinLockGuard`/`recordPinResult` wrapper every other caller uses. 10,000 combinations, no lockout.
- Money movement is reachable (`esusu_contribute`, :174-179), as are balances, history and account details — all unauthenticated.
- Raw provider errors are returned to the caller (:208).

Listed Critical because the gap between "dark" and "live" is one environment variable, and the blast radius is total account compromise.

#### Promoted from High in revision 2 — the equity feature is live

These three were rated High on the assumption the subsystem was still dark. It is not. IDs are unchanged so earlier references still resolve. What makes them Critical is that **none of them requires an attacker** — they trigger from ordinary concurrent usage and from any deploy landing mid-order.

**P3-H-01 (now Critical) — Concurrent orders can be funded by each other's money.** Every leg measures its result as an on-chain **balance delta of the single shared omnibus custody wallet** (`hyperfx.ts:183, 225-230`; `equity-broker.ts:269, 287`). There is no mutual exclusion across orders. A concurrent sell's USDC arriving during a buy's ~195-second poll window is attributed to the buy; a `withdrawFromLend` redemption during a sell's window is credited to the seller as sale proceeds. Both directions are real value transfer between unrelated customers. The supply lock does not prevent this: it guards only pool supply, it is released before leg 2 (`equity-broker.ts:363`), it **fails open** on RPC error, and `placeEquityOrder` proceeds even when it never acquires it (:350-356). Detection query in 4.0(b).

**P3-H-03 (now Critical) — Stranded orders leave customers debited with nothing.** The buy completes inside a fire-and-forget `void (async () => …)()` (`invest/equity/route.ts:146`) with no `maxDuration` declared. If the process dies between the debit and settlement — deploy, restart, OOM, timeout — the order stays `pending` **forever**. There is no reconciler for `equity_orders` or `equity_sales`; the only reconcilers in the tree cover Strails deposits and withdrawals. The sell side is worse: shares and cost basis are already removed, so the customer loses the position too. Note this fires on **every deploy** that lands while an order is in flight, and orders take 1–2 minutes. Detection query in 4.0(a).

**P3-H-04 (now Critical) — Leg-1-success / leg-2-failure makes the refund fictional.** If the stock swap fails after the HyperFX leg succeeded, the catch refunds the customer's cNGN **in the database** while the cNGN is already escrowed and custody holds USDC instead. The customer is whole; the treasury silently absorbs it and the ledger now claims cNGN that no on-chain cNGN backs. Mirror case on sells: shares are restored after the tokens were already sold. This is not a rare path — the founder's own note at `equity-broker.ts:117-122` accepts that thin pools "can occasionally refund a buy," which is precisely this branch. Repeated occurrences accumulate as unbacked ledger balance. Reconciliation in 4.0(c).

### 4.2 High

#### Equity / HyperFX subsystem

The subsystem is **off by default in code** — `EQUITY_ENABLED`, `EQUITY_BROKER=base_dex` and `HYPERFX_ENABLED` must all be set. **Confirmed by leadership on 5 Sept: it is switched on in production.** So every finding below is live, not hypothetical.

Worth noting as a process gap in its own right: neither `.env.example` nor `frontend/.env.local.example` documents any of these flags, so there is no operator checklist for a subsystem that moves customer money into foreign securities. The per-symbol kill switch also ships disabling nothing — all ten tickers are live by default per `chore(invest): keep all verified stocks enabled by default (founder call)`, including the five recorded at ~$5k of pool depth.

> **Revision 3, forensics run and partial fix shipped.** Commits `c4290c0` and `1feb522` close the **sell** half of `P3-H-03` and `P3-H-04`. A new `settling` status parks a sale whose stock leg executed but whose cNGN leg found no solver, so shares are no longer falsely restored, the sell amount is clamped to the actual custody balance which fixes the sell symptom of `P3-M-16`, and `cron/equity-sell-reconcile` retries the conversion and credits. Good work, and it should not be rebuilt. The **buy** side remains entirely unaddressed.
>
> Forensics against production found: **no stranded buys**, **two stranded sells** both on the team's own account, **no cross-customer contamination** since every overlapping order pair was one user with themselves, and implied FX rates clustering inside ±1.6% with no outliers. So `P3-H-01` has not fired, largely because the product has one active user rather than because the code is safe.
>
> **Two new findings from the same exercise.** First, the sell reconciler runs `convertUsdcToCngn` from a cron every 10 minutes, adding a **third concurrent actor** on the shared custody wallet alongside user buys and sells, still measuring a whole-wallet balance delta. It raises `P3-H-01` exposure rather than lowering it, and it does not verify custody still holds the recorded USDC before converting. Second, every filled buy implies roughly **1440 naira per USDC** while the code's fallback rate is **1600** in three places. The sell fair-value floor divides by that rate, so it sits about 11% looser than intended, and stacked on the 10% impact tolerance the protection is roughly twice as loose as designed.
>
> Operationally: custody holds **0.0006 ETH** against the 0.05 documented in `OPERATIONS_GUIDE.md`, and **0.37 USDC** against the HyperFX fee buffer requirement. The buy refund rate is **61%**, 14 refunded against 9 filled. The feature is live on a wallet that frequently cannot afford to complete an order.

**P3-H-02 Oversized buys fill badly; the code believes they refund.**

> **Downgraded to Medium in revision 3.** Quoting real trades against both venues at $10, $100, $1k and $3k shows **all ten pools are deep**, price impact under 0.2% at $3,000 on every symbol. The `:52-58` "$1M+, flat to $3k" comment is right and the `:104-110` "~$5k at enable time" note is wrong. The code defect below is real, the buy path passes no floor while the sell path does, but there is no thin pool to dump into at realistic size. Worth closing for a large order or a future thin listing, and because the comments mislead. No longer High. `equity-broker.ts:115-116` and `:236-238` both assert that a thin route "can only fail, never fill at a bad price." That is wrong: `minOut` is derived _from the quote_, and the quote already contains the price impact. So `minOut` bounds quote-to-execution drift only. The sell path passes a real market-relative floor (`minAcceptableOut`); **the buy path passes none** (`:367` omits the argument). With six pools documented at roughly $5k depth and all ten symbols enabled by default, and no per-order ceiling above the ₦1,000 floor, a large buy simply fills at whatever the curve gives and is recorded as success.

**P3-H-05 — Unlimited approvals of the omnibus wallet, including to a non-canonical router.** Four MAX approvals with no revocation path anywhere: input token and fee token to the Hyperbridge IntentGateway (`hyperfx.ts:155-161`), input token to the winning DEX router (`equity-broker.ts:264-267`), and the payout token to the GetEquity market. The standout is Aerodrome: the code comments (`:52-58`) explain they deliberately use a _different periphery deployment_ than the documented Slipstream router because the canonical one can't reach these pools. An unlimited approval of every user's USDC and stock balance to a self-identified, non-canonical router is the highest-severity approval here.

**P3-H-06 — HyperFX accepts a 50% fill as success.** `hyperfx.ts:221`: `threshold = quote.amountOut / 2n`, and any positive delta passes (`:231`). A solver filling half the quote produces a "successful" buy where the customer paid in full for half the shares — no partial refund, no minimum-output enforcement. Separately, on the timeout path the escrowed input is **never reclaimed**, so a late fill means the platform has paid twice.

**P3-H-07 — Route-level guards are bypassable via PostgREST.** `place_equity_order`, `place_equity_sell`, `create_loan` and `repay_loan` are all `GRANT EXECUTE ... TO authenticated` (verified across migrations 032/042/068). A user can call them directly, skipping the broker-live check, catalog membership, the ₦1,000 floor and the fair-value floor — producing a self-inflicted debit or share reservation that **no background worker and no reconciler will ever settle or refund**.

#### Residency and jurisdiction

**P3-H-17 — There is no residency or US-person check anywhere in the flow.** Nigeria eligibility has been confirmed informally via the Base Africa team, which addresses whether a Nigerian customer may hold these instruments. It does not address the control that is actually missing.

These are **Reg S, non-US-only** instruments issued by Coinbase Onchain SPV Ltd (`equity-broker.ts:12`). The required control is therefore not "confirm Nigeria is permitted" but "**block customers who are not**". Grepped the whole flow: no country field is consulted, no residency attestation, no US-person screening, no IP or geo gate, no sanctions or PEP check. Anyone who can sign up can buy, from anywhere.

This matters more than usual because **custody is omnibus**. The issuer sees one wallet. A jurisdictional freeze triggered by a single ineligible holder freezes **every customer's position simultaneously**, and customers hold a database row rather than a claim on the token, so there is no per-user segregation and no documented recovery path.

Two things remain open and neither is engineering's to decide:
1. The issuer-side eligibility determination in writing — from Coinbase's SPV or their published offering restrictions, rather than from the Base ecosystem team, who are not the party whose restriction it is.
2. Whether PawaSave is authorised under Nigerian law to distribute foreign securities to retail customers. That is a question about us, not about the token, and the Base team cannot speak to it.

`equity-broker.ts:29-32` also assumes full biometric KYC gates every order. Migrations 064 and 068 subsequently relaxed that to accept BVN onboarding alone, so the control the compliance note relied on is weaker than the note believes.

#### Application layer

**P3-H-08 — Admin authentication is still one shared static password.** `lib/admin-session.ts`. The httpOnly signed cookie is correctly implemented, but the **body-password fallback is still present on all six admin routes** (:63-70), and the HMAC signing key still defaults to `ADMIN_PASSWORD` itself (:17) — so knowing the password lets you forge session tokens. No per-operator identity, no MFA, no audit trail of who moved money. The new IP-keyed lockout (migration 031) covers only `/api/admin/verify`; the body-password path on the other five routes has no lockout, and the IP comes from a spoofable `x-forwarded-for`.

**P3-H-09 — No maximum withdrawal amount.** `api/ramp/route.ts:968-975` validates only a minimum. A user with `kyc_status='verified'` has **no ceiling at all** (:904) — no per-transaction cap, no velocity limit, no manual-approval threshold. Combined with P3-C-01 and P3-C-03 (self-verify KYC) this is the path that converts a forged balance into real naira. For a custodial deposit-taker it is the single most conspicuous missing control.

**P3-H-10 — Webhooks still trust the provider's amount over our own record.** `flipeet-webhook/route.ts:180`: `readNumber(data?.source?.amount, data?.amount, body.amount, tx.amount_kobo / 100)` — our own record is the _last_ fallback. Anyone holding the webhook token can credit an arbitrary amount against a ₦100 pending deposit. Same pattern in `webhook/route.ts:110` and `xend-webhook:80`. Reported previously; unfixed.

**P3-H-11 — No custody-signer serialisation.** At least six independent paths sign from the same `CUSTODY_PRIVATE_KEY`: off-ramp sends, pool supply and withdrawal, admin supply-idle, equity swaps, GetEquity, and HyperFX. `custody.ts:16-23` builds a fresh wallet per call with node-managed nonces, while `hyperfx.ts:149-194` pre-computes nonces locally — two nonce sources on one account. `supply-lock.ts` covers only pool supply and **fails open** on RPC error. Collisions produce dropped or replaced transactions on money paths.

#### Contracts

**P3-H-12 — "Borrowing disabled" is not enforced on-chain, and the same branch widened borrowing.** Commit `49720e1` ("PawasaveLend becomes a holding layer") touches **zero contract files**. The mechanism is a client-side `throw` in `use-lend-pool.ts`, plus `scripts/block-borrowing.ts` — an operator-run script that calls `removeCollateral()`, is gated on `totalBorrows() == 0`, is not in CI, has no evidence of having been executed, and is reversible with one `addCollateral()` call. `borrow()` remains `external` and un-flagged. Meanwhile this branch **widened** tenors from {30,90,180} to any value in 7–365 days (ceiling 730, `PawasaveLend.sol:58-62`, new `setMaxTenor`) and raised default `maxBorrowPerUser` from ₦50M to **₦200M** (`deploy-lend.ts`). Four previously-scoped findings are dormant _only_ while this unverified posture holds.

**P3-H-13 — The lending pool still cannot absorb a bad debt.** `liquidate` requires `collateralBalances[token] >= seizeAmount` (:377-380), so a position underwater beyond the 10% bonus **cannot be liquidated at all**. `totalPoolAssets()` (:412-417) keeps counting uncollectible `totalBorrows` as an asset, so `exchangeRate` stays overstated: early redeemers exit whole and the last suppliers absorb everything. Grepped: **no write-off function exists in `PawasaveLend.sol`** — `writeOff` exists only on the separate CreditLine contract. `insuranceFund` only ever receives; there is no path to inject it against a shortfall.

**P3-H-14 — Lending-pool share inflation, unchanged and now maximally exposed.** `supply()` (:185-206) computes shares against `totalPoolAssets()`, which reads the **raw token balance** (:415). No virtual shares, no decimals offset (the vault has one — `_decimalsOffset() = 6`), and **no `require(sharesToMint > 0)`**, so a late depositor whose rounding truncates to zero still has their cNGN taken. A direct transfer to the pool inflates the share price with no issuance. This is independent of borrowing — and holding-layer mode, where the pool is pure raw balance, is precisely its maximal exposure.

**P3-H-15 — Vault admin role retained by a known-exposed key, and ownership never completed.** The constructor grants `DEFAULT_ADMIN_ROLE` to the deployer EOA (`PawasaveAutoVault.sol:107`), and `scripts/transfer-ownership.ts` knows only `transferOwnership` — grepped, it contains no `renounceRole` or `grantRole`. So the deployer permanently retains AccessControl admin and can re-grant itself roles regardless of `Ownable2Step`. The v1 tracker states this deployer key is **exposed** and still a Safe signer. Separately, `V2-INFRA-05` confirms the vault's `acceptOwnership()` was never called, so the vault is likely still deployer-owned. `PawasaveLendStrategy` — whose new `setPaused` halts all vault deposits — is plain `Ownable` and not covered by the script at all.

**P3-H-16 — Strategy migration orphans funds, and the new guard turns that into a redemption DoS.** `executePrimaryStrategy` (:351-358) rewrites a pointer only; no sweep, no `require(old.totalAssets() == 0)`. Funds stay in the old strategy while `deployedAssets` still counts them. The new `require(... >= assets, "Strategy withdraw shortfall")` (:219-239) then makes **every redemption revert** until an operator manually unwinds. `maxWithdraw`/`maxRedeem` remain unoverridden, so ERC-4626 integrators are misinformed about both locks and liquidity.

### 4.3 Medium

| ID      | Finding                                                                                                                                                                                                                                                                                                                                        | Location                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| P3-M-01 | Zero `SECURITY DEFINER` functions set `search_path` (0 of 130 definition sites). Standard privilege-escalation vector and a Supabase linter finding.                                                                                                                                                                                           | all migrations                                             |
| P3-M-02 | **Corrected in revision 3.** The repository never enables RLS on `revenue_journal`, `deposit_scan_state`, `fixed_savings_rates` or `proxy_transfers`, but **production has RLS on all four**, apparently via an `rls_auto_enable` function that exists in the database and in no migration. Three of them have zero policies, which correctly denies clients. So this finding does not hold against production, and the real gap is `P3-C-01`: the bulk enable missed `wallets` and `profiles`, the two tables that matter most. The repo-versus-production divergence is itself the lesson. | production introspection |
| P3-M-03 | Zero views use `security_invoker`, so all execute with owner rights and bypass RLS. Migration `040_fix_revenue_views.sql` repointed them at `platform_fees` — a table whose RLS is deny-all — so the exposure **widened**. `/admin/revenue` reads them as a client component with no authentication.                                           | `040_fix_revenue_views.sql`; `app/admin/revenue/page.tsx`  |
| P3-M-04 | `if (!depositWalletConfigured())` is missing `await` on an async function, so the guard never fires. Sibling call sites do it correctly. If every wallet row has a persisted address the scan proceeds unconfigured, credits nothing, and **advances the block cursor**, permanently skipping that range.                                      | `lib/deposit-scan.ts:174`                                  |
| P3-M-05 | PostgREST filter injection: webhook-supplied `reference` interpolated unescaped into a `.or()` expression. Low direct impact behind the token, but a live injection primitive in a service-role query. Reported previously; unfixed.                                                                                                           | `flipeet-webhook/route.ts:120`                             |
| P3-M-06 | `revenue-withdraw` lost update: read balance → external provider call → write an absolute value. Two concurrent withdrawals decrement once for two payouts. Reported previously; unfixed.                                                                                                                                                      | `admin/revenue-withdraw/route.ts:73-126`                   |
| P3-M-07 | BVN daily-cap TOCTOU: the rolling-24h sum is read before the withdrawal row is inserted, so concurrent requests both pass. The comment claims parallel requests can't bypass it.                                                                                                                                                               | `api/ramp/route.ts:925-947`                                |
| P3-M-08 | BVN and NIN hashed with **no salt**, so a leak of these columns leaks every BVN across an 11-digit space. **Corrected in revision 2:** `ops/env-checklist.md` establishes `BVN_HASH_SALT` was never set in production, so every existing hash used an empty salt. Setting it now breaks identity matching for every existing customer, and re-hashing needs raw BVNs which are not stored. This requires a versioned forward-only scheme, new hashes salted and legacy hashes matched under a compatibility path, not the one line fix originally implied. Moved out of Week 1. | `kyc/create-session/route.ts:60`; `ussd/route.ts:87`       |
| P3-M-09 | Reconciler can false-complete on provider address reuse: the shape-B match searches all history from block 0 and takes the most recent transfer, without comparing amount or requiring a timestamp after the row's creation. An old transfer would complete a new withdrawal that never sent.                                                  | `cron/reconcile-withdrawals:167-176`; `custody.ts:196-215` |
| P3-M-10 | Stale withdrawals with no marker are marked `failed` **without refund** and with no alert; the admin route deliberately cannot touch balances. Money-safe by construction, but converts a system fault into a silent customer loss requiring manual SQL.                                                                                       | migration 039; `admin/reconcile-withdrawals`               |
| P3-M-11 | Rate limiting fails open on Redis error or timeout and falls back to a per-instance in-memory map — empty on every cold start, which is the exact bypass the Upstash migration was meant to close.                                                                                                                                             | `middleware.ts:52, 87`                                     |
| P3-M-12 | CSP retains `unsafe-inline` and `unsafe-eval` in `script-src`, which removes most of its XSS value — and the admin cookie's entire rationale is XSS resistance while the body-password fallback remains capturable from a form. Separately, `Permissions-Policy: camera=()` will block the Sense biometric SDK, likely an active KYC bug.      | `next.config.js:38, 50-51`                                 |
| P3-M-13 | `PawasaveLendStrategy` — the bridge every production vault deposit flows through — has effectively **zero coverage**. Its one test passes an **EOA as the lend pool** so only `setPaused` is exercised; `deposit`, `withdraw`, `harvest`, the round-up share math and principal drift are untested. No fuzz or invariant tests exist anywhere. | `test/audit-v2-source.ts:80-104`                           |
| P3-M-14 | `strails-relay` forwards **any method to any path** matching a loose regex, including withdrawal endpoints, so `RELAY_SECRET` is functionally equivalent to the API key. The split buys IP stability, not privilege separation.                                                                                                                | `strails-relay/index.js`                                   |
| P3-M-15 | `strails-webhook` returns 200 on signature failure and triggers an internal cron using the server's `CRON_SECRET`. The money reasoning is sound (nothing from the body is trusted on that path), but it leaves an unauthenticated internet lever on a job that spends gas and burns provider quota.                                            | `strails-webhook/route.ts:44-77`                           |
| P3-M-16 | Share quantities are JavaScript floats end to end. `Math.floor(shares * 1e8)` on sell leaves on-chain dust while the DB decrements the exact float, accumulating unowned dust and ledger/chain divergence.                                                                                                                                     | `equity-broker.ts:369, 384, 396`                           |
| P3-M-17 | Withdrawal amount accepts non-integer naira (`Number.isFinite` only), and the ledger row and the on-chain send round in different directions.                                                                                                                                                                                                  | `api/ramp/route.ts:954`                                    |
| P3-M-18 | Both Vercel crons and the self-hosted crontab are declared, at different cadences. If both hosts are live during cutover every job runs twice concurrently. Most credit paths are idempotent, but this should not rest on that.                                                                                                                | `vercel.json` vs `ops/cron/crontab`                        |
| P3-M-19 | No non-negativity `CHECK` on any balance column, and the ledger is single-entry, `direction` is a text label rather than a paired posting, so a balance cannot be proven from history. Integer-division dust also vanishes in the esusu 95/5 split. **Confirmed concretely in revision 3:** reconciling all 44 wallets showed withdrawals populate `amount_kobo` and leave `amount_usdc_micro` at zero, while deposits populate both. The ledger therefore cannot be summed in one unit without special-casing per transaction type, and any naive reconciliation silently omits every withdrawal. Strongest argument yet for taking the double-entry decision now rather than deferring it. | schema-wide, verified against production |
| P3-M-20 | `ops/decrypt-mnemonic.mjs` writes the master seed to stdout, does not mask the passphrase prompt, and uses default scrypt cost. Its documented producing endpoint (`/api/admin/export-mnemonic`) **no longer exists**, so the recovery procedure in `DEPLOY.md` is broken.                                                                     | `ops/decrypt-mnemonic.mjs`; `ops/DEPLOY.md`                |
| P3-M-21 | Raw error messages returned to callers on several routes, including Postgres RPC text (`api/loans:141,154`), custody balances (`admin/supply-idle:59-62`), and raw provider errors to unauthenticated USSD callers (`ussd:208`).                                                                                                               | multiple                                                   |

### 4.4 Operational — ground truth cannot be established

**P3-OPS-01 — The deployed branch is not `main`.** See Section 2. `ops/DEPLOY.md` compounds it by instructing operators to deploy `main`.

**P3-OPS-02 — Three contradictory live contract address sets, including an executable footgun.**

| Source                                                            | Lend          | Vault         |
| ----------------------------------------------------------------- | ------------- | ------------- |
| `deployments/*.json` (newest, machine-generated)                  | `0x5583802F…` | `0xcBA4ED7C…` |
| `frontend/src/lib/contracts.ts` (runtime default, marked `// v3`) | `0x5583802F…` | `0xcBA4ED7C…` |
| `SECURITY_AUDIT_REMEDIATION.md`                                   | `0x07F2365D…` | `0x423750c8…` |
| `OPERATIONS_GUIDE.md:55`                                          | `0xA540FB9a…` | —             |
| `frontend/.env.local.example:116`                                 | —             | `0x7F64f8B7…` |

The v3 set is almost certainly live. But `frontend/.env.local.example` ships a **non-empty** vault address matching no deployment record, and because `contracts.ts` reads `process.env.… || "0xcBA4ED7C…"`, anyone copying the example env verbatim points production at the wrong vault. Every other address in that file is a blank placeholder. The whitepaper page still publishes v2 addresses to end users. The v3 strategy address appears in exactly one file and no documentation.

**P3-OPS-03 — Deployed bytecode is unverified against source.** `AUDIT_V2_REMEDIATION.md` still lists the v2 source fixes as "not live until the v3 redeploy," while `deployments/*.json` shows v3 already deployed at a newer timestamp. Either the tracker is stale or the deployed v3 predates those fixes. **Until this is resolved, no status claim in either tracker can be trusted.**

**P3-OPS-04 — Migration state is unknowable.** No CLI, no ledger, hand-pasted SQL, duplicate `007` (×3) and `017` (×2), and 16 missing numbers between 045 and 062. Two of the three `007` files both define `record_platform_fee` and only one carries the REVOKEs — last paste wins and there is no record of which.

**P3-OPS-05 — Documentation contradicts the code on user-facing claims.** The terms and whitepaper pages now tell customers the pool is a zero-yield holding layer with borrowing moved off-chain. The deployed contract is a fully functional interest-bearing lending pool with live `accrueInterest`, `borrowAPR`, reserve factor and liquidation, all reachable. That gap is a disclosure risk, not just a docs bug.

### 4.5 What improved since the last pass — credit where due

Reviewed and found sound:

- **The off-ramp fee is now genuinely withheld.** The gross-up in `runFlipeet` replaces the previous phantom-revenue accounting, and the row's `amount_kobo` is the total debited so every refund path derives from one field.
- **KYC is now enforced server-side** with real tiered caps (₦20k without BVN, ₦3M rolling 24h with BVN, uncapped on full biometric). This was browser-only before.
- **Withdrawal reconciliation is genuinely well-designed.** The durable pre-send settlement marker with read-after-write confirmation, the "abort rather than send unverifiably" rule, and the guarded-claim `resolve()` pattern together mean I could find **no double-refund path**. Migration 039 correctly removed the blind SQL auto-refund.
- **Server-side PIN handling** with current-PIN proof, DB-backed lockout, and migration 045's trigger blocking client writes.
- **Admin login throttling** (migration 031) correctly revokes EXECUTE from `anon`/`authenticated`.
- **Cron authorization fails closed** — 503 when the secret is unset rather than running unprotected.
- **Webhook signatures** are properly verified and fail-closed for Flint (HMAC-SHA512), Xend (RSA) and Sense KYC (HMAC-SHA256).
- **Equity cost-basis accounting is now correct.** Migration 068's average-cost removal, failure restore, and historical backfill properly fix the fake-loss bug.
- **`credit_strails_deposit` is atomic and idempotent** (migration 067), and `crypto_deposits.tx_key` remains correctly idempotent.
- **Money is integer minor units throughout the schema** — no floating-point columns anywhere.
- **New oracle minimum-price floor** enforced on the shared path so it also binds `forceSetPrice`.
- **No live secrets committed.** Git history across all 249 commits scanned — placeholders only. The client bundle is clean; no service key, admin password or private key is behind a `NEXT_PUBLIC_` prefix.
- **The remediation trackers are honest about what is not done**, which is rarer than it should be and made this pass much faster.

---

## 5. What this means commercially

**The promised yield is still not earned.** Customers are quoted 27–50% APY; the pool earns approximately nothing; interest is credited from a configured number rather than realised yield. The APY figure itself disagrees across four locations in the codebase. This is a liability compounding in the database and it sets the clock on everything else.

**Borrowing was turned off, which removes the only yield source that existed.** The stated plan moves borrowing to an asset-backed, Daya-funded model. Until that produces revenue, the subsidy continues and the pool is a pure cost centre.

**The equity product changes the regulatory picture materially, and it is live.** `equity-broker.ts:29-32` states plainly that tokenized US equities to non-US retail is regulated, that these are Reg S instruments, that the issuer can freeze wallets in prohibited jurisdictions, and that **"Nigeria eligibility MUST be confirmed before EQUITY_ENABLED is set."**

Nigeria eligibility has now been confirmed informally via the Base Africa team, which is progress. Two gaps remain, detailed in `P3-H-17`: there is still **no residency or US-person screening in the flow**, so the control the Reg S restriction actually requires — excluding ineligible customers — does not exist; and the question of whether PawaSave is authorised under Nigerian law to distribute foreign securities to retail customers has not been put to anyone qualified to answer it. Neither is engineering's call, but the first is engineering's to build and is scheduled in Week 2.

Also unenforced server-side: suitability, risk disclosure, and any per-customer investment cap. And because custody is omnibus, an issuer freeze triggered by one ineligible holder freezes every customer at once.

---

## 6. Four weeks — plan

Each week ends at a **gate**: a verifiable condition, not a status update. Nothing proceeds past a failed gate without an explicit decision.

### Week 1 (8–12 Sep) — Close both live money-loss paths

**Revised in revision 2.** Week 1 now runs two tracks, because there are two live paths losing money by different mechanisms and neither should wait on the other. Track A is a deliberate-exploitation risk; Track B is an ongoing malfunction. This is more than comfortably fits in a week, and the honest consequence is that some Week 2 application work slips — flagged now rather than discovered later.

_Priority 0, before any fix is written:_

- Run everything in Section 4.0 — the stranded-order and contamination queries, the ledger-versus-chain reconciliation, the thin-symbol reduction, and the order ceiling. This tells us the realised cost so far and cheaply bounds further exposure.
- Dump production schema and diff against all 55 migrations. Establish what is actually applied. Gates everything else.
- Verify deployed contract bytecode against HEAD and resolve P3-OPS-03.
- Confirm whether `USSD_ENABLED` is set in production. `EQUITY_ENABLED` and `HYPERFX_ENABLED` are confirmed on.
- Resolve the pool-depth contradiction in `equity-broker.ts` with one quoter call — it decides whether the order ceiling stays.
- Restore a working environment and run the test suite.

_Track A — the database, as one reviewed migration:_

- Remove client UPDATE grants on `wallets`, `profiles`, `savings_locks`; route mutations through service-role RPCs (P3-C-01, P3-C-03).
- `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` across the schema; re-grant the minimum of the 79. Make credit-side functions service-role only. Move `place_equity_order`/`place_equity_sell`/`create_loan`/`repay_loan` off `authenticated` (P3-C-02, P3-H-07).
- Enable RLS on the four exposed tables; add `security_invoker` to all views; authenticate `/admin/revenue` (P3-M-02, P3-M-03).
- `SET search_path` on every definer function (P3-M-01).
- Non-negativity CHECKs; `UNIQUE` on `transactions(reference)` and provider ids (P3-M-19).

_Track A, alongside the migration:_

- The approved interim withdrawal ceiling — enforced as a hard cap **outside** the KYC-tier logic, so it cannot be bypassed by the same self-declared field (see P3-C-03). Plus a permanent maximum amount and integer-naira validation (P3-H-09, P3-M-17).
- Confirm `USSD_ENABLED` is false and add a hard fail-closed guard requiring the gateway secret (P3-C-05).
- **Ledger reconciliation** against deposit history — if P3-C-01 was exploited, we need to know this week.

_Track B — stop the equity path bleeding:_

- **Serialise every custody-touching flow** behind one lease keyed on the custody address, held for a whole order, failing **closed**. Better still, stop using bare `balanceOf` deltas and parse `Transfer`/`Swap` events from the specific receipt (P3-H-01, P3-H-11).
- Build the equity reconciler: scan `equity_orders`/`equity_sales` stuck pending, verify on-chain, then settle or refund. Add an explicit `maxDuration` and a durable order state machine that survives process death (P3-H-03, P3-H-04).
- Resolve every stranded order found in 4.0(a) by hand, and make whole any customer harmed by contamination found in 4.0(b).

**Gate 1:** An adversarial test suite runs against staging attempting balance forgery, direct RPC invocation, cross-user credit, self-KYC and self-matured locks — every attempt fails. Ledger reconciliation against deposit history is clean or discrepancies are quantified. No `equity_orders` or `equity_sales` row can remain `pending` beyond the reconciler window. A concurrency test proves two simultaneous orders cannot be attributed each other's output.

### Week 2 (15–19 Sep) — Equity correctness and the residency gate

Track B's containment landed in Week 1. This is the remaining correctness work, plus the application-layer items.

- Pass a fair-value floor to the buy leg; correct the two comments claiming oversized buys refund; make the per-order and per-day ceilings permanent (P3-H-02).
- **Build the residency / US-person gate** (P3-H-17). Required regardless of the Nigeria confirmation, because the Reg S restriction is about excluding ineligible customers, not admitting eligible ones.
- Raise the HyperFX fill threshold to ≥97% of quote and attempt escrow reclaim on timeout (P3-H-06).
- Replace MAX approvals with exact-amount approve plus zero-out, especially the non-canonical Aerodrome router (P3-H-05).
- Move `place_equity_order`/`place_equity_sell`/`create_loan`/`repay_loan` off `authenticated` if not already done in Week 1 (P3-H-07).
- Fix the webhook amount-trust issue, the `.or()` injection, the missing `await`, the revenue lost update, and the BVN cap TOCTOU (P3-H-10, P3-M-04, P3-M-05, P3-M-06, P3-M-07).
- Design a versioned forward-only BVN hash scheme (P3-M-08). Not a salt-and-ship change, see the corrected finding.
- Remove the admin body-password fallback; require a distinct session secret; add per-operator identity and an action audit log (P3-H-08).

**Gate 2:** Every money-moving endpoint has an integration test covering success, each failure path, and the partial-failure/refund path. An ineligible-residency customer cannot place an order. Recorded revenue equals revenue held.

### Week 3 (22–26 Sep) — Contracts, while value at risk is still low

- `_beforeTokenTransfer` override — restores the entire fixed-savings product (P3-C-04).
- Bad-debt accounting: write-off path, socialised loss, insurance-fund injection (P3-H-13).
- Virtual shares plus `require(sharesToMint > 0)` on the lending pool (P3-H-14).
- **Decide and enforce the borrowing posture in code**, not in the frontend. If borrowing is off, disable it on-chain; if it is on, the bad-debt and collateral findings are live and gate any TVL. Reconcile the widened tenor and ₦200M cap with the stated posture (P3-H-12).
- Separate collateral accounting from supplier cash.
- Force fund migration on strategy swap; override `maxWithdraw`/`maxRedeem` (P3-H-16).
- Move vault `DEFAULT_ADMIN_ROLE` to the Safe and renounce the deployer's; complete `acceptOwnership()`; bring the strategy owner under the Safe; rotate the exposed deployer key (P3-H-15).
- Real test coverage for `PawasaveLendStrategy` against an actual pool; convert `PawasaveLend.test.ts` off shared state (P3-M-13).

**Gate 3:** Invariant tests hold under fuzzing — pool assets versus shares, locked shares versus balance, borrow index monotonicity. Full suite green including new strategy, bad-debt and lock-transfer tests. Contracts ready for external review.

### Week 4 (29 Sep–3 Oct) — Ground truth, stress, and the yield question

_Ground truth:_

- Merge the live branch to `main` or rename the trunk; fix `ops/DEPLOY.md`; enable branch protection (P3-OPS-01).
- Adopt the Supabase CLI, snapshot production as the baseline, renumber duplicates, document the 046–061 gap (P3-OPS-04).
- One authoritative contract address source; fix `frontend/.env.local.example`; update the whitepaper page; delete abandoned records (P3-OPS-02).
- Reconcile user-facing claims with contract reality (P3-OPS-05).
- CI: `npm ci`, add `next build`, secret scanning, RLS/migration linting.
- Retire the Vercel crons at cutover (P3-M-18).

_Stress and integration testing:_

- Load-test for the concurrency races: simultaneous withdrawals on one balance, concurrent admin revenue withdrawals, duplicate webhook delivery, concurrent equity orders through shared custody.
- Fork-test the full deposit → supply → harvest → withdraw cycle against Base state, including the untested vault-to-pool bridge.
- Failure injection: provider timeout mid-withdrawal, oracle keeper stall past staleness, process death mid-equity-order, pool at full utilisation during a vault redemption, HyperFX no-bid and partial fill.
- Verify cron idempotency under double invocation.

_Prototyping:_

- **A real yield source.** This is the strategic bottleneck: borrowing is off, the pool earns nothing, and the promised APY is subsidised. The asset-backed/Daya model is the stated direction and the CreditLine contract already exists — the design problem is making managed, uncollateralised credit safe enough to route customer deposits into (first-loss capital, tranching, on-chain exposure limits, transparent reporting). Deliverable: design document plus testnet prototype, not production code.
- **Esusu as an underwriting signal.** Contribution behaviour is a repayment-history dataset nobody else has, and it is the route to the borrower base the pool needs. Timeboxed spike.

**Gate 4:** Schema, contract addresses and deploy branch each have exactly one authoritative source. Load and failure-injection results documented with remediation for anything found. Both prototypes reviewed with a go/no-go.

---

## 7. Deliberately out of scope

- **Formal external contract audit.** Recommended before meaningful TVL; Week 3 leaves the contracts reviewable.
- **Migrating keys to KMS / signer isolation.** Five hot keys plus the HD master seed are all reachable from the same web process; `ops/DEPLOY.md` defers this to "Phase 2." It is a real tail risk needing an infrastructure decision.
- **Rotating the exposed deployer key** out of the Safe signer set — flagged in Week 3 but requires Safe co-signers.
- **Legal determination of Reg S eligibility and Nigerian distribution authorisation.** Nigeria-side holder eligibility has been informally confirmed; issuer-side written confirmation and our own authorisation to distribute foreign securities to retail remain open. Engineering builds the residency gate (Week 2, `P3-H-17`); it cannot decide the legal answer.
- **Real KYC provider expansion** beyond the existing Sense/Strails integration.

---

## 8. Decisions — answered and outstanding

### Answered on 5 Sept

1. **Cap withdrawals during Week 1?** ✅ **Approved.** Implementation note: it must be enforced as a hard ceiling *outside* the KYC-tier logic. The existing ₦20k / ₦3M / uncapped tiering is correctly built, but it reads `kyc_status` from a row the customer can edit (`P3-C-03`), so a cap routed through that field inherits the same bypass.

2. **Is the equity feature live in production?** ✅ **Answered — yes.** This drove revision 2: three findings promoted to Critical, Week 1 split into two tracks, and Section 4.0 added.

3. **Nigeria eligibility for tokenized equities?** ⚠️ **Partially answered.** Confirmed informally via the Base Africa team. Two things remain open, neither blocking the engineering work:
   - The confirmation would be stronger coming from the **token issuer** (Coinbase Onchain SPV Ltd, per `equity-broker.ts:12`) or their published offering restrictions, rather than from the Base ecosystem team, who are not the party whose restriction it is.
   - Whether **PawaSave is authorised under Nigerian law to distribute foreign securities to retail customers** is a separate question about us rather than about the token, and has not been put to anyone qualified to answer it.
   - Separately and regardless: the missing control is **excluding ineligible customers**, not admitting eligible ones. That gap is `P3-H-17` and is scheduled for Week 2.

### Still outstanding

4. **Is borrowing on or off?** The frontend says off, the contracts say on, and the same branch widened tenors to 365 days and quadrupled the per-borrower cap to ₦200M. Whichever it is, it should be enforced in one place. If it is off, several findings become dormant and Week 3 shortens.

5. **Double-entry ledger: now or later?** Balances currently cannot be proven from history, which will matter at audit, at licensing, and during any incident. Materially cheaper now than after another year of volume. I will bring costings in Week 2.

6. **What is the actual promised APY?** Four different figures live in the codebase. We should be able to state one and show where it comes from.

7. ~~**Do we keep the thin-pool symbols live?**~~ **Answered, no action needed.** Measured against both venues: all ten pools hold price flat to within 0.2% at a $3,000 order. Keep every symbol enabled. The "~$5k depth" note in the code is wrong and should be corrected so nobody acts on it later.

---

## Appendix — Inventory at `0796523`

| Component          | Scale                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Solidity contracts | 9 files, 1,911 lines — `PawasaveLend` (660), `PawasaveAutoVault` (404), `PawasaveCreditLine` (305), `PriceOracle`, `InterestRateModel`, `PawasaveLendStrategy` (100), interface + 2 mocks |
| Contract tests     | 7 files, 1,169 lines. No fuzz or invariant tests. Production vault↔pool bridge effectively uncovered.                                                                                     |
| Frontend pages     | 10                                                                                                                                                                                        |
| API routes         | **50** (was 25 in June) — 9 admin, 11 cron, 6 ramp, 5 webhook, 4 invest, 3 strails, plus loans, USSD, KYC, statement, push, security                                                      |
| Server libraries   | 35 files, 5,417 lines (was 18 / 2,624)                                                                                                                                                    |
| DB migrations      | 55 files, 6,967 lines. Duplicate `007` (×3), `017` (×2); 16 numbers missing between 045 and 062.                                                                                          |
| DB tables          | 30 — 26 with RLS, **4 with none**. 3 carry row-scoped UPDATE policies on balance-bearing tables.                                                                                          |
| DB functions       | 79 distinct (130 definition sites), nearly all `SECURITY DEFINER`. **13 revoked from PUBLIC. 0 set `search_path`.**                                                                       |
| Views              | 6, **none** with `security_invoker`                                                                                                                                                       |
| Scheduled jobs     | 11, declared on both Vercel and a self-hosted crontab                                                                                                                                     |
| Hot signing keys   | 5 distinct keys + 1 HD master mnemonic, all reachable from the web process                                                                                                                |
| Frontend/API tests | **0**                                                                                                                                                                                     |

**This pass (revision 2):** 8 Critical · 14 High · 21 Medium · 5 operational.
*Revision 1 read 5 / 16 / 21. `P3-H-01`, `P3-H-03` and `P3-H-04` were promoted to Critical once the equity feature was confirmed live; `P3-H-17` (residency gate) was added. IDs are stable across revisions.*
**Prior passes:** 83 findings, 45 marked complete.

---

_Every Critical and High finding was confirmed by direct source inspection and is cited to file and line for independent verification. Test execution, production schema inspection and live chain state were not available in the audit environment; all three are Priority 0 in Week 1, and several severities above depend on their outcome._
