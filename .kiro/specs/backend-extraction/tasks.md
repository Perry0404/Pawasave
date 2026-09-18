# Backend Extraction: Tasks

**Spec:** `backend-extraction`
**Requirements:** `requirements.md` · **Design:** `design.md` · **Contract:** `inventory.json`

Phase 0 blocks everything. Phase 1 builds the harness that makes every later phase verifiable,
so it is not optional scaffolding. Phases 3 waves run in order of blast radius.

Ordering constraints that matter:
- Task 5a (init backend repo, vendor the contract) blocks task 6, which reads the vendored copy
- Task 6 (parity harness) blocks all of Phase 3, it is the only completeness check
- Task 5 (compat layer) blocks all of Phase 3, every moved handler depends on it
- Wave 3 onward must wait for `week1-critical-remediation` task 20 to land and verify
- Within every wave: backend deploys before the frontend repoints. Two repos, no atomic deploy
- Task 21 (remove server deps from frontend) must follow the last route move, not precede it
- Task 27 (delete cookie auth fallback) must follow the final wave, or in-flight routes break
- Task 30 is the gate

## Baseline

**Branch cut from:** `audit-v2-remediation-and-flint-onramp` — record the exact commit at task 1.
**Inventory at spec time:** `1b12125` — 65 routes, 39 lib modules, 122 server env vars,
44 client fetch sites, 2 shared modules, 1 dead module.

## Decisions on record

| | Decision | Source |
|---|---|---|
| Domain | `pawasave.xyz`; frontend at apex, backend at `api.pawasave.xyz`, cookie `Domain=.pawasave.xyz` | founder, task 4 |
| Repo model | `backend/` is a standalone repo, gitignored by the parent | founder, task 2 |
| Framework | Hono + `@hono/node-server` on Node 22 | `design.md` §2, from the 56-of-65 web-standard handler measurement |
| Shared code | Duplicate 2 modules, no workspace | `design.md` §7 |
| User auth | Bearer token, cookie fallback during migration only | `design.md` §5.1 |
| Admin auth | Keep `httpOnly` cookie, add `Domain` | `design.md` §5.2, preserves `V2-HIGH-03` |
| Browser-to-Postgres | Out of scope, documented in R9 | `requirements.md` §4 |

## Hosting context

Production today: Coolify on Hetzner, Cloudflare in front, Docker from `frontend/Dockerfile`,
Supabase managed, Vercel retired. Target: Contabo, two processes behind nginx on subdomains of
one registrable domain. **No staging environment exists** (`week1-critical-remediation` tasks 11
and 12 create one; use it if it lands first).

## Note on a revision

An earlier sketch of this work had a phase that de-Nexted `cron-auth` and `admin-session`
in place before moving anything. The design's compat layer (`design.md` §4) makes that
unnecessary: the adapters present the surface the handlers already expect, so the modules move
unchanged instead of being rewritten twice. One fewer edit pass over money-moving code.

---

## Phase 0 — Baseline (blocks all other work)

- [x] 1. Record the baseline
  - **Baseline: `1b1212551d732fab72316eb99d0daa7ec3d5cbd8`** on
    `audit-v2-remediation-and-flint-onramp`, 2026-09-18 09:40:43 +0100. Recorded in
    `backend/spec/baseline.json`
  - **`main` is not stale in a dangerous way.** `git merge-base --is-ancestor` confirms the audit
    branch contains all of `main`, and is 199 commits ahead with 0 commits behind. `main` is simply
    behind; nothing was lost and there was no failed merge. The baseline commit is itself a merge
    of `main` into the audit branch, made the same day
  - **The parent working tree stays on `main` for now.** Because `backend/` is a separate
    gitignored repository (task 2), the backend is built by reading the audit branch with
    `git show`, so no checkout is needed and the founder's working tree is left untouched. The
    parent tree only needs to move to the audit branch for Phase 4, the frontend-side cleanup
  - _Requirements: R1.1_

- [x] 2. Repository model: `backend/` is its own repo
  - **Decided by the founder.** `backend/` is a standalone git repository living inside the
    `Pawasave` working directory and excluded from the parent via `.gitignore:21` (`/backend/`).
    Confirmed with `git check-ignore`
  - Consequences are designed for in `design.md` §2a: history cannot follow files across the
    boundary, `inventory.json` must be vendored for the backend's CI, CI is per-repo, and deploys
    are not atomic so the backend route must go live before the frontend repoints
  - The empty repo already present at `backend/.git` (zero commits) is the one to use
  - _Requirements: R1.4, R1.5_

- [x] 3. Inventory generated and verified against the baseline
  - Generated from `1b12125`: **65 routes, 39 lib modules, 122 server env vars, 44 client fetch
    sites**. Matches the expected totals, so the branch has not moved under the spec
  - Classification: 29 server-only, 7 client-only, 2 shared, 1 dead (`pauto-vault`)
  - `check-wave-coverage.mjs` passes: all 64 backend routes assigned to exactly one wave
  - _Requirements: R1.2, R1.3_

- [x] 4. Deployment hostnames
  - **Decided by the founder:** domain is `pawasave.xyz`
  - Frontend keeps the apex, `https://pawasave.xyz`. That is already `site-url.ts`'s production
    fallback and is baked into auth redirect links and Ajo invite links, so moving it would break
    external links
  - Backend takes `https://api.pawasave.xyz`
  - Admin cookie `Domain=.pawasave.xyz`, covering apex and subdomain. Apex plus subdomain are
    same-site, so `SameSite` does not need weakening and `httpOnly` survives (`design.md` §5.2)
  - CORS allowlist: exactly `https://pawasave.xyz`, from env
  - _Requirements: R6.2, R6.3, R7.4_

## Phase 1 — Scaffold and harness

- [x] 5. Scaffold `backend/` and build the compat layer
  - Done, commit `03f1adf`. Hono 4.13.8 + `@hono/node-server` 2.1.1, 19 compat tests green
  - `vitest` dropped: npm 10.8.2's arborist crashes resolving its peer graph. Using
    `node:test` via `node --import tsx --test`, which suits plain assertions anyway
  - `tsc-alias` `resolveFullPaths` confirmed working: extensionless `@/lib/x` authoring
    emits `./lib/x.js`, so moved files need no import edits and Node ESM still resolves
  - `package.json` with `hono` v4.12.x and `@hono/node-server` v2, Node 22; no `next`, `react`
    or `react-dom`
  - `tsconfig.json` with `noEmit: false`, `outDir: dist`, and `paths: { "@/*": ["./src/*"] }`
    matching the frontend alias exactly, so moved files need no import rewrites
  - Build via `tsc` + `tsc-alias`
  - `compat/response.ts` exporting a `NextResponse`-shaped `json()` over Web `Response`; keeping
    the export name is deliberate, it keeps ~400 call sites untouched
  - `compat/cookies.ts` providing async `cookies()` over `AsyncLocalStorage` request context
  - `compat/cron-auth.ts` preserving the `checkCronAuth(req) → Response | null` contract
  - `compat/auth-user.ts` accepting bearer token **or** session cookie during migration, and
    forwarding the user JWT to Supabase so RPCs run as `authenticated`
  - `compat/auth-admin.ts` preserving the `httpOnly` cookie, adding the `Domain` from task 4
  - _Requirements: R2.1, R2.4, R5.1, R5.2, R6.1_

- [x] 5a. Initialise the backend repository and vendor the contract
  - Done, commit `6b8eb23`
  - Use the existing empty repo at `backend/.git`; first commit message records the exact parent
    commit the code is taken from, since history cannot cross the boundary
  - Vendor `inventory.json` to `backend/spec/inventory.json`; the parity gates read this copy
  - Add a staleness check comparing the vendored copy's recorded source commit against the
    backend's baseline, failing CI when they drift apart
  - Add `backend/.gitignore` covering `node_modules/`, `dist/`, `.env`, `*.pem`, and
    `.hyperbridge-cache/`
  - _Requirements: R1.4, R1.5, R3.7_

- [x] 6. Build the parity harness and wire it into CI
  - `backend/test/parity.test.ts` reading `inventory.json` and asserting: every URL registered;
    methods match exactly both directions; every `serverEnv` var present in `.env.example`; every
    `ops/cron/crontab` path resolves to a registered route
  - A repo check that `frontend/src/app/api/` contains no `route.ts`, expected to fail until
    Phase 3 completes, so make it report progress (n of 64 moved) rather than just pass/fail
  - Keep `check-wave-coverage.mjs` green. It asserts every backend route is assigned to exactly
    one wave, and it already caught `ramp/resolve-account` being missed when the waves were
    first drafted. Re-run it after any wave edit
  - CI is per-repo. The backend gets its **own** `.github/workflows/ci.yml` running typecheck,
    the parity gates, the vendored-contract staleness check and a dependency audit at `high`,
    mirroring the parent's existing `frontend` job. The parent's workflow cannot see `backend/`
  - The "`frontend/src/app/api/` is empty" check goes in the **parent** repo's workflow
  - _Requirements: R3.1, R3.2, R3.3, R3.4, R3.5, R3.6, R3.7_

- [x] 7. Build the normalised-diff tool for faithfulness review
  - Given an original and a moved file, emit a diff excluding import lines, the registration
    wrapper, and removed route segment config
  - Expected output for a faithful move is empty
  - This is what makes R4 checkable; every task in Phase 3 depends on it
  - _Requirements: R4.1, R4.2, R4.3_

## Phase 2 — Server-side modules

- [x] 8. Move the 29 server-only lib modules
  - Done, commit `273f530`. All 31 (29 server-only + 2 shared) byte-identical, confirmed by
    `normalise-diff all-libs`: faithful 31, differs 0
  - Done via committed `scripts/move-libs.mjs` so the transformation is auditable. Only
    `admin-session` and `cron-auth` needed an edit, both just their first import line
  - `tsconfig` now includes `DOM` in `lib`, and `src/types/next-fetch.d.ts` declares the
    inert `next: { revalidate }` fetch option. Both exist so the 31 files need no edits
  - Verified all 31 import successfully from `dist/`, so ESM extensions and the internal
    dependency graph resolve at runtime
  - Copy into the backend repo, then delete from the frontend. `git mv` is not available across
    the repository boundary; provenance comes from the normalised diff plus the baseline commit
    (`design.md` §2a)
  - `admin-session`, `cron-auth`, `crosschain-deposit`,
    `custody-lease`, `custody`, `deposit-chains`, `deposit-fee`, `deposit-scan`, `deposit-sweep`,
    `deposit-wallet`, `equity-broker`, `equity-prices`, `flipeet`, `getequity`, `hyperfx`,
    `kyc-sense`, `mailer`, `ngx`, `notify-tx`, `pin-hash`, `pin-lockout`, `push-send`,
    `ramp-rate`, `rpc-provider`, `secrets`, `statement-html`, `strails`, `xend`,
    `yield/aggregator`
  - `admin-session` and `cron-auth` swap their `next/server` import for the compat equivalents;
    no other logic changes
  - Verify each with the task 7 tool
  - _Requirements: R2.2, R4.1, R4.2, R4.5_

- [x] 9. Duplicate the 2 shared modules and handle drift
  - Done, commit `273f530`. Provenance in `src/lib/vendored.json` rather than a header
    comment, so the files stay byte-identical and the faithfulness diff stays clean
  - `test/vendored.test.ts` verifies the local copies match their vendored hash. Still
    cannot see the frontend copy changing; the comment in the frontend copies is task 21
  - Copy `contracts.ts` (server importer: `yield/aggregator.ts`) and `site-url.ts` (server
    importer: `notify-tx.ts`) into `backend/src/lib/`
  - Each copy carries a header recording the source commit and a SHA-256 of the original; backend
    CI verifies the local file still matches the recorded hash
  - Be honest about the limit: this catches an accidental edit to the backend copy, not the
    frontend copy changing. Cross-repo CI cannot see the other side (`design.md` §7)
  - Add a comment in the **frontend** copies naming the backend as a consumer, so a reviewer
    touching them knows to sync
  - Keep the `NEXT_PUBLIC_*` variable names; note in `.env.example` why a non-Next server reads
    them, and file the rename as a follow-up
  - _Requirements: R9.3_

- [ ] 10. Delete `pauto-vault.ts` from the frontend
  - 378 lines, zero importers anywhere in the tree, confirmed by the inventory importer graph
  - **Not ported**, verified by a test asserting it is absent from the backend
  - The frontend deletion is deferred to Phase 4, because it needs the parent working tree
    on the audit branch and the tree is deliberately still on `main`
  - Own commit so it is trivially revertible
  - _Requirements: R9.4_

## Phase 3 — Route waves

Every task below: move the handler, swap imports for compat, register in Hono, drop the Next
segment config (its `maxDuration` becomes a proxy and runner timeout concern, see task 22),
confirm an empty normalised diff, confirm the parity gate count rises by the expected number.

**Deploy order within every wave is fixed, because the two repos cannot deploy atomically:**
register and deploy the backend route, verify it serves, switch the nginx location block, and only
then remove the Next route. A frontend pointing at a route that is not yet live is an outage.

- [x] 11. Wave 1 — unauthenticated reads (**4** routes, not 5)
  - Done, commit `0c537cc`. `invest/quotes`, `ramp/rate`, `ramp/banks`, `ramp/status`. All
    byte-identical, only their first import line changed
  - **`invest/ngx` was mis-assigned here.** It gates on a Supabase session and 401s without
    one, so it is not an unauthenticated read. Moved to the head of wave 2, where it is the
    right subject for task 12: read-only market data, no money at stake
  - Verified against live external APIs including the fallback branches, which is what
    proves faithfulness rather than mere compilation: `ramp/banks` fell through Flint to
    Paystack and returned 285 banks, `ramp/rate` fell back to the default rate,
    `ramp/status` correctly reported the naira rail down. POST to a GET-only route 404s
  - `ramp/status` unauthenticated custody and StraiLs read preserved as-is, finding 2
  - _Requirements: R3.1, R4.1, R4.2_

- [x] 12. Verify the user-JWT path on a real `authenticated` RPC
  - Done, commit `18f6f2c`. 9 tests in `test/auth-user.test.ts` plus 5 end-to-end in
    `test/route-auth.test.ts`
  - No staging Supabase exists, so the tests stand up a fake one on loopback and record what
    the client actually sends. No test hooks were added to production code
  - Proven: RPCs and table reads both carry the user's JWT with the anon `apikey`; the
    service-role key never appears in a user client; the forwarded token carries
    `role=authenticated` and `sub`=`auth.uid()`; `serviceClient` still escalates for routes
    that already did; the two clients are not interchangeable
  - Proven end to end through `invest/ngx`: 401 anonymous, 401 on a bad token, 200 on a good
    one, and 401 rather than 500, which shows the request context was established
  - **Scope limit, stated honestly:** this proves credential construction and forwarding. It
    does not prove PostgREST resolves the role as documented, which needs a real database.
    Re-check against staging once `week1-critical-remediation` tasks 11 and 12 create one
  - `normalise-diff` now recognises the canonical session-helper substitution and reports it
    explicitly. It only strips a helper it can prove is the standard shape, so a variant
    still surfaces as a real diff
  - _Requirements: R5.1, R5.2, R5.4_

- [ ] 13. Wave 2 — authenticated, not money-moving (**10** routes, 1 done)
  - `invest/ngx` heads this wave, reassigned from wave 1 (see task 11). **Done** in task 12,
    commit `18f6f2c`, as the subject of the user-JWT verification
  - Remaining 9: `wallet/deposit-address`, `wallet/sync-deposits`, `push/subscribe`,
    `security/pin`, `statement`, `welcome`, `esusu/contributed`, `esusu/group/[groupId]`,
    `esusu/yield`
  - Apply the same canonical `getSupabaseUser` adapter substitution; `normalise-diff` will
    confirm nothing else changed
  - `wallet/deposit-address`, `wallet/sync-deposits`, `push/subscribe`, `security/pin`,
    `statement`, `welcome`, `esusu/contributed`, `esusu/group/[groupId]`, `esusu/yield`
  - `esusu/group/[groupId]` is a dynamic segment and unauthenticated, gated only by a UUID
    regex; preserve exactly and file a finding
  - _Requirements: R3.1, R4.1, R5.3_

- [ ] 14. Wave 3 — money-moving, single provider (15 routes)
  - **Blocked on `week1-critical-remediation` task 20 landing and verifying**
  - `p2p/*` (6), `savings/forfeit-withdraw`, `loans`, `kyc/create-session`, `strails/onboard`,
    `strails/onboard-status`, `strails/probe`, `proxy`, `ussd`, `ramp/resolve-account`
  - `proxy` carries both admin and user auth; it needs task 19's cookie work, so either sequence
    it after wave 6 or land the admin cookie change early
  - `ussd` returns early unless `USSD_ENABLED` is set, which it is not in production
    (`week1-critical-remediation` task 4); preserve that guard exactly
  - _Requirements: R3.1, R4.1, R5.2, R5.3_

- [ ] 15. Wave 4 — webhooks (5 routes)
  - `webhook` (Flint HMAC), `flipeet-webhook` (query token), `xend-webhook` (RSA),
    `strails-webhook` (cron secret), `kyc/webhook`
  - Signature verification must be byte-identical; a reworded error or reordered check can
    silently accept or reject callbacks
  - Coordinate provider callback URLs. Where the provider allows it, point at the backend and
    keep the Next route alive until traffic is confirmed moved, then retire it
  - CORS must not apply to callers that send no `Origin`
  - _Requirements: R3.1, R4.2, R7.3_

- [ ] 16. Wave 5 — cron routes (16 routes)
  - All `cron/*`. They move together because `BASE_URL` switches once
  - Do not re-point the crontab yet; that is task 22, after the proxy and runner timeouts are
    correct
  - _Requirements: R3.1, R3.4, R4.1_

- [ ] 17. Wave 6 — admin routes (9 routes)
  - `admin/clear-secrets-cache`, `admin/dashboard`, `admin/logout`,
    `admin/reconcile-withdrawals`, `admin/revenue-balance`, `admin/revenue-withdraw`,
    `admin/supply-idle`, `admin/verify`, `admin/yield`
  - Requires the cookie `Domain` change from task 4. Keep `httpOnly`, `Secure` and `SameSite`
  - Leave the password-in-body fallback in place; removing it belongs to `P3-H-08`
  - _Requirements: R3.1, R6.1, R6.2, R6.4_

- [ ] 18. Wave 7 — highest value at risk (5 routes)
  - `ramp` (1432 lines, 9 lib deps), `invest/equity`, `invest/equity/sell`, `invest/getequity`,
    `xend`
  - No refactoring. The normalised diff must be empty; review the wrapper, not the 1432 lines
  - `ramp` is the single largest handler in the codebase and the most consequential; move it last
    with the harness fully proven
  - _Requirements: R3.1, R4.1, R4.2, R4.3_

- [ ] 19. Confirm full route parity
  - Parity gate reports 64 of 64 moved, methods matching, and `frontend/src/app/api/` empty
    except `auth/callback`, which stays by design
  - _Requirements: R3.1, R3.2, R3.5_

## Phase 4 — Frontend cleanup

- [ ] 20. Introduce the API base URL and a single fetch wrapper
  - One helper owning base URL, `Authorization: Bearer` from the Supabase session, and
    `credentials: 'include'` where admin cookies are needed
  - Repoint all 44 fetch sites through it. They are currently hardcoded relative paths across
    `lib/flint.ts`, `components/*` and `app/*`; the full list is in `inventory.md`
  - Base URL from env, defaulting to same-origin so the pre-cutover build still works
  - _Requirements: R5.1, R7.1_

- [ ] 21. Remove the API surface and server dependencies from the frontend
  - Delete `frontend/src/app/api/` (keeping `app/auth/callback`)
  - Remove server-only deps from `frontend/package.json`: `@aws-sdk/client-secrets-manager`,
    `@hyperbridge/sdk`, `ethers`, `nodemailer`, `web-push`, `viem`, and the `@types/*` for them.
    Verify against the inventory before removing any, some may have a client importer
  - Confirm `npm ci` now succeeds against a strict lockfile. `@hyperbridge/sdk` is the dep the
    current Dockerfile blames for forcing `npm install`, and it is server-only
  - Remove the `.hyperbridge-cache` workaround from `frontend/Dockerfile`; it moves to the backend
  - _Requirements: R2.4, R2.5_

## Phase 5 — Operations

- [ ] 22. Fix the cron runner timeout and re-point it at the backend
  - `pawasave-cron.sh` uses `curl -m 120`. Four routes declare `maxDuration=300`:
    `cron/equity-buy-reconcile`, `cron/equity-sell-reconcile`, `cron/scan-crosschain-deposits`,
    plus the equity paths they drive. Those jobs are being cut off today and reported to
    healthchecks.io as failures
  - Raise to 310; set nginx `proxy_read_timeout` to match
  - Point `BASE_URL` in `cron.env` at the backend
  - This is the one pre-existing defect fixed in-flight, justified under R4.4 because carrying it
    into new infrastructure would knowingly ship a break
  - _Requirements: R8.1, R8.2, R8.3_

- [ ] 23. Partition the environment and strip secrets from the frontend host
  - Generate `backend/.env.example` from `inventory.json` `serverEnv`; the parity gate asserts
    coverage
  - Produce a per-side checklist: which of the 122 vars go to the backend, which stay
  - **Remove** every server secret from the frontend's environment, do not merely duplicate them.
    `CUSTODY_PRIVATE_KEY`, `DEPOSIT_WALLET_MNEMONIC`, all keeper keys,
    `SUPABASE_SERVICE_ROLE_KEY`, every provider API key. Verify by inspection of the deployed
    frontend environment, not by reading the checklist back
  - Note in `.env.example` why a non-Next server reads `NEXT_PUBLIC_*` names
  - _Requirements: R8.6_

- [ ] 24. Backend Dockerfile and service definition
  - Model on `frontend/Dockerfile`: multi-stage, Node 22 alpine, non-root, healthcheck
  - Carry the `.hyperbridge-cache` writable-directory fix
  - Bake no secrets; everything at runtime
  - _Requirements: R2.1, R2.3_

- [ ] 25. nginx, CORS and rate limiting
  - nginx: path-prefix routing so a wave can be switched independently, which is the only
    rollback mechanism available without staging
  - CORS: exact allowlisted origin from env, `Access-Control-Allow-Credentials`, never a
    wildcard; requests without `Origin` unaffected
  - Port the rate limiter with identical buckets (admin 10/min, ramp 15/min, other 30/min),
    Upstash with in-memory fallback, fail-open preserved
  - Resolve the client IP correctly through Cloudflare and nginx. Prefer `CF-Connecting-IP`;
    verify with a probe before relying on the limiter, or every caller shares one bucket
  - Confirm whether the Cloudflare WAF rate limit on `/api/*` is configured
    (`week1-critical-remediation` task 4 left this open)
  - Move API security headers to the backend; CSP and frame options stay with the frontend
  - _Requirements: R7.1, R7.2, R7.3, R7.4, R8.4, R8.5_

- [ ] 26. Prove the backend is genuinely standalone
  - Build and start from a checkout containing only `backend/`
  - With the frontend stopped, exercise every route class and run every cron job to completion
  - Assert no import path traverses above `backend/`
  - _Requirements: R2.1, R2.2, R2.3_

## Phase 6 — Cutover and gate

- [ ] 27. Delete the cookie auth fallback for user sessions
  - Only after the final wave. `compat/auth-user.ts` drops the cookie path and accepts bearer
    tokens only
  - Explicit task, not cleanup left to chance
  - _Requirements: R5.1_

- [ ] 28. Cut over wave by wave on Contabo
  - Switch one nginx location block at a time; verify before the next
  - Rollback is reverting the block
  - Backend deploys first in every wave. The two repos cannot deploy together, so a frontend
    referencing a route the backend has not yet registered is an outage
  - Watch healthchecks.io across a full cron cycle, including the daily 00:00, 01:00 and 02:00
    UTC jobs, before declaring cron migrated
  - _Requirements: R8.1_

- [ ] 29. Document the residual coupling
  - The 44 browser-to-Postgres call sites: 15 RPCs, 15 tables, across `hooks/use-data.ts` (25),
    `components/groups-view.tsx` (16), `app/admin/revenue/page.tsx` (4),
    `app/join/[groupId]/page.tsx` (1). Cross-reference `week1-critical-remediation` task 20 and
    its `rpc-allowlist.json`
  - The two realtime subscriptions on `wallets` and `transactions`, which keep an anon Supabase
    client in the browser regardless
  - The 2 duplicated shared modules and how the drift check keeps them honest
  - State plainly that the extraction separated the API, not all server-side logic
  - _Requirements: R9.1, R9.2, R9.3_

- [ ] 30. Gate
  - Parity: 64 of 64 routes, methods matching, `frontend/src/app/api/` empty but for
    `auth/callback`, every `serverEnv` var covered, every crontab path resolving
  - Faithfulness: a normalised diff on record for every moved handler, each empty or justified
  - Standalone: task 26 passed
  - Secrets: verified absent from the frontend environment
  - Cron: a full cycle observed green on healthchecks.io
  - Findings filed, not fixed: `ramp/status` unauthenticated, `esusu/group/[groupId]`
    regex-gated, `NEXT_PUBLIC_*` names server-side, `/api/ramp` size
  - _Requirements: all_

---

## Findings log

Defects noticed during the extraction go here and are **not** fixed in-flight (R4.4). Populate as
they arise.

| # | Finding | Where | Disposition |
|---|---|---|---|
| 1 | Cron runner `curl -m 120` cuts off **three** cron routes declaring `maxDuration=300`: `equity-sell-reconcile`, `equity-buy-reconcile`, `scan-crosschain-deposits`. Now proven mechanically by the inventory generator, see `inventory.json` `cron.exceedingRunnerTimeout` | `ops/cron/pawasave-cron.sh` | **Fixed in-flight**, task 22, R8.2 |
| 2 | `ramp/status` reads custody and StraiLs with no authentication | `api/ramp/status` | Filed, preserve as-is |
| 3 | `esusu/group/[groupId]` does a service-role read gated only by a UUID regex | `api/esusu/group/[groupId]` | Filed, preserve as-is |
| 4 | `NEXT_PUBLIC_*` variables read server-side | `contracts.ts`, `custody.ts`, others | Filed, rename is a follow-up |
| 5 | `/api/ramp` is 1432 lines with 9 lib dependencies | `api/ramp` | Filed, separate spec |
| 6 | `pauto-vault.ts`, 378 lines, zero importers | `lib/pauto-vault.ts` | Deleted, task 10 |
| 7 | `/api/cron/getequity-yield` exists with cron auth and `maxDuration=60` but is **never scheduled**. 16 cron routes, 15 crontab entries | `api/cron/getequity-yield`, `ops/cron/crontab` | Filed. Port it anyway, it is a route. Someone must decide whether it should be scheduled or deleted |
| 8 | The contract missed all six operational secrets because `secrets.ts` reads `process.env[name]` with a runtime string. A backend deployed from the old list would have had no `CUSTODY_PRIVATE_KEY` and signed nothing | `derive-inventory.mjs` | **Fixed.** Generator now scans `getSecret()` call sites; 122 env vars became 129 |
| 9 | `ethers` pinned at `^6.10.0` in `package.json` but production resolves `6.17.0`. The caret range hides a 7-minor drift in the chain library that signs custody transactions | `frontend/package.json` | Backend pins `6.17.0` to match production. Frontend should pin too, filed as follow-up |
| 10 | Two `high` `ws` advisories via `@hyperbridge/sdk`'s bundled copy. Only npm-offered fix is a breaking downgrade to `@hyperbridge/sdk@1.0.0` | `@hyperbridge/sdk` 2.8.11 | Filed. Production carries the identical exposure. Backend CI blocks on `critical`, reports `high` non-blocking |
