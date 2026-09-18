# Backend Extraction: Requirements

**Spec:** `backend-extraction`
**Branch under change:** cut from `audit-v2-remediation-and-flint-onramp`
**Target:** a standalone `backend/` server, deployable to Contabo independently of the frontend
**Status:** Requirements — awaiting review before design sign-off

---

## 1. Objective

Split the single Next.js process into two independently deployable applications: a `frontend/`
that serves UI, and a `backend/` that owns every server-side responsibility. The backend is the
full server package minus the frontend.

This is a **relocation, not a rewrite**. The behaviour of 65 route handlers and 31 server-side
modules must be identical before and after. Most of that code moves customer money, and the
project has no staging environment (see `week1-critical-remediation`, Phase 5), so the only
defensible approach is a faithful port with mechanical verification at every step.

## 2. What "nothing missed, nothing invented" means

Two failure modes are equally unacceptable, and every requirement below exists to rule out one
of them.

| | Omission | Invention |
|---|---|---|
| Looks like | A route never gets registered; an env var is absent in production; a cron stops firing | A handler gets "tidied up" during the move and changes behaviour |
| Detected by | Machine-derived parity gates (R3) | Line-level diff review (R4) |
| Consequence | Silent feature loss, a money cron that no longer runs | A payment bug shipped with no staging to catch it |

The inventory in `inventory.json` is the contract. It was **derived mechanically** by
`derive-inventory.mjs` reading the git object store, precisely because a hand-written list of
65 routes and 122 env vars would miss things.

## 3. Reconnaissance already completed

Four facts were established before this spec and they shape the design.

**3.1 — The working tree was three months stale.** The tree sat on `main` (`e27a575`,
2026-06-18) which has 24 routes and 18 lib modules. The live branch,
`audit-v2-remediation-and-flint-onramp` (`1b12125`), has **65 routes and 39 lib modules**. Any
plan built on `main` would have missed roughly two thirds of the backend, including the loans,
equity, P2P, USSD, StraiLs, KYC and push domains.

**3.2 — The VPS migration is already half done.** On the live branch `frontend/vercel.json` is
deleted, `frontend/Dockerfile` builds a Next standalone image for self-hosting, and `ops/cron/`
holds a real crontab of 16 jobs driven by `pawasave-cron.sh` with healthchecks.io dead-man's
-switch pings. Cron already calls `BASE_URL=http://127.0.0.1:3000` with a Bearer secret.
*Consequence:* cron does not need designing. It needs `BASE_URL` re-pointed and one timeout bug
fixed (3.4).

**3.3 — The client/server split is cleaner than expected.** Of 39 lib modules: 29 are
server-only, 7 are client-only, **2 are genuinely shared** (`contracts` with one server
importer, `site-url` with one server importer), and 1 is dead (`pauto-vault`, zero importers).
*Consequence:* no shared package or npm workspace is needed. Two modules with one server
importer each is a duplication problem, not an architecture problem.

**3.4 — The cron runner will time out on four routes.** `pawasave-cron.sh` calls
`curl -m 120`. Four routes declare `maxDuration=300`: `cron/equity-buy-reconcile`,
`cron/equity-sell-reconcile`, `cron/scan-crosschain-deposits`, and (at 300 via its
handler) the equity paths under `invest/`. This is a pre-existing defect, not one the
extraction introduces, but the extraction must not carry it forward.

## 4. Scope

**In scope**
- A standalone `backend/` application owning all 64 `/api/*` routes
- The 29 server-only lib modules, plus a resolution for the 2 shared ones
- An auth model that survives the frontend and backend being separate origins
- Rate limiting, relocated from Next middleware
- Env var partition, deployment artifacts, and cron re-pointing
- Machine-verifiable parity gates proving completeness and faithfulness

**Out of scope**
- **The 44 browser-to-Postgres call sites.** 15 RPCs and 15 tables reached directly from
  `use-data.ts`, `groups-view.tsx`, `admin/revenue/page.tsx` and `join/[groupId]`. This is a
  genuine second backend, and closing it is already partly owned by
  `week1-critical-remediation` task 20 and its `rpc-allowlist.json`. Tracked in R9 so the
  boundary is honest, but not done here.
- **Refactoring `/api/ramp`.** It is 1432 lines with 9 lib dependencies. It moves as-is. A
  split is a separate spec.
- **Any behavioural change**, including fixing defects noticed in passing. Those get recorded
  and filed, not fixed mid-move. The one exception is 3.4, because carrying a known timeout
  into new infrastructure would be knowingly shipping a break.
- `/auth/callback` — stays in the frontend (see design; it is a browser redirect flow that must
  set session cookies on the frontend origin).

## 5. Interaction with in-flight work

`week1-critical-remediation` is active on the same branch and overlaps twice:

- Its **task 20** revokes `anon`/`authenticated` RPC grants. The backend must forward the user
  JWT rather than escalate to service role, or Group B RPCs will run with the wrong identity
  and `auth.uid()` checks will misfire. R5.4 covers this.
- Its **Week 2** item `P3-H-08` rebuilds admin auth. R6 must not conflict. The decision here is
  to preserve the existing httpOnly cookie mechanism rather than replace it, leaving `P3-H-08`
  free to land independently.

This spec should not start Phase 3 or later until the week1 database work has settled, because
both touch the same auth surface.

---

## 6. Requirements

### R1 — Work proceeds from the correct baseline

**Story:** As the engineer doing the extraction, I need certainty about which code I am moving,
because the tree I was handed was three months stale.

**Acceptance criteria**
1. WHEN work begins, THEN the working tree SHALL be on a branch cut from
   `audit-v2-remediation-and-flint-onramp`, and the commit it was cut from SHALL be recorded in
   `tasks.md`.
2. WHEN the branch is cut, THEN `derive-inventory.mjs` SHALL be re-run against it and
   `inventory.json` regenerated, so the contract matches the actual baseline.
3. IF `inventory.json` totals differ from 65 routes / 39 libs, THEN the difference SHALL be
   explained in writing before any file moves.
4. WHEN the backend repository is initialised, THEN its first commit message SHALL record the
   exact parent-repo commit the code was taken from, since history cannot follow files across a
   repository boundary (`design.md` §2a).
5. WHEN the backend repository is initialised, THEN `inventory.json` SHALL be vendored into it,
   because the parity gates run in the backend's own CI and cannot read the parent repo.

### R2 — The backend is genuinely standalone

**Story:** As the operator deploying to Contabo, I need the backend to run without the frontend
present, so the two can be deployed and scaled separately.

**Acceptance criteria**
1. WHEN the backend is built from a checkout containing only `backend/`, THEN it SHALL compile
   and start successfully.
2. WHEN the backend starts, THEN it SHALL NOT import from `frontend/`, and no import path SHALL
   traverse above `backend/`.
3. WHEN the backend is running and the frontend is stopped, THEN every `/api/*` route SHALL
   still serve, and every cron job SHALL still complete.
4. WHEN the backend package is inspected, THEN it SHALL declare only dependencies it actually
   uses, and SHALL NOT depend on `next`, `react`, or `react-dom`.
5. WHEN the frontend is built after the extraction, THEN it SHALL NOT contain any server-only
   dependency, and `npm ci` SHALL succeed against a strict lockfile (currently blocked by
   `@hyperbridge/sdk`, a server dependency).

### R3 — Completeness is machine-verified, not reviewed by eye

**Story:** As the reviewer, I need proof that no route, env var or scheduled job was lost,
because 65 routes cannot be checked reliably by hand.

**Acceptance criteria**
1. WHEN the parity check runs, THEN it SHALL assert that every URL in `inventory.json` is
   registered in the backend router, and SHALL fail listing any that are absent.
2. WHEN the parity check runs, THEN it SHALL assert that each route's registered HTTP methods
   exactly match the methods recorded in `inventory.json`, with no additions or omissions.
3. WHEN the parity check runs, THEN it SHALL assert that every env var in `inventory.json`
   `serverEnv` is present in the backend's env template.
4. WHEN the parity check runs, THEN it SHALL assert that every path referenced in
   `ops/cron/crontab` resolves to a registered backend route.
5. WHEN the extraction is complete, THEN `frontend/src/app/api/` SHALL contain no `route.ts`
   files, and a check SHALL enforce this so routes cannot be silently left behind or re-added.
6. WHEN the parity check runs, THEN it SHALL be part of the backend repository's own CI and SHALL
   block merge on failure. The check in R3.5 SHALL run in the parent repository's CI, since the
   two live in different repositories.
7. WHEN the vendored `inventory.json` is older than the backend's baseline commit, THEN CI SHALL
   fail, so the contract cannot silently go stale.

### R4 — Handler logic is ported faithfully

**Story:** As the person accountable for customer funds, I need to know the move did not change
behaviour, because there is no staging environment to catch a regression.

**Acceptance criteria**
1. WHEN a route handler is moved, THEN the only permitted edits SHALL be: import paths, the
   request/response adapter at the handler boundary, and removal of Next route segment config.
2. WHEN a route handler is moved, THEN its business logic, arithmetic, database calls, error
   handling, ordering, and log messages SHALL be unchanged.
3. WHEN a route is moved, THEN a normalised diff against the original SHALL be produced and
   reviewed, and anything beyond the edits permitted by R4.1 SHALL be justified in the commit
   body or reverted.
4. IF a defect is discovered in a handler during the move, THEN it SHALL be recorded as a
   finding and left in place, EXCEPT where leaving it would break on the new infrastructure.
5. WHEN a module is moved, THEN its provenance SHALL be recorded by the normalised diff and the
   backend's baseline commit, since `backend/` is a separate repository and `git mv` cannot carry
   history across the boundary (`design.md` §2a). Per-file `git log` continuity is explicitly
   not a requirement.

### R5 — User authentication survives the origin split

**Story:** As a signed-in customer, I need my requests to keep working when the API moves to a
different origin, and I need my identity to reach Postgres unchanged.

**Acceptance criteria**
1. WHEN a signed-in user calls a backend route, THEN the backend SHALL establish the same user
   identity it establishes today via `createServerClient` and `cookies()`.
2. WHEN the backend calls a Supabase RPC on a user's behalf, THEN it SHALL do so with the
   user's JWT so the call executes as `authenticated` with the correct `auth.uid()`, and SHALL
   NOT substitute the service role.
3. WHEN a route uses the service role today, THEN it SHALL continue to use the service role,
   and WHEN a route uses the user session today, THEN it SHALL continue to use the user
   session. The extraction SHALL NOT change which client any route uses.
4. WHEN `week1-critical-remediation` task 20 revokes client RPC grants, THEN backend routes
   SHALL continue to function, because R5.2 preserves the calling identity.
5. WHEN an unauthenticated request reaches a route that requires a user, THEN it SHALL receive
   the same status code it receives today.

### R6 — Admin session hardening is not regressed

**Story:** As the operator, I need the admin session to stay immune to token theft by XSS,
because that protection was added deliberately.

**Acceptance criteria**
1. WHEN the admin session mechanism is moved, THEN the session token SHALL remain in an
   `httpOnly` cookie and SHALL NOT become readable by JavaScript.
2. WHEN the admin cookie is issued cross-origin, THEN it SHALL remain `Secure` and SHALL retain
   a `SameSite` value no weaker than `Lax`.
3. WHEN the cookie's scope is widened to reach the backend origin, THEN the change SHALL be
   recorded explicitly, including the new `Domain` attribute and why it is safe.
4. WHEN the extraction is complete, THEN the `P3-H-08` admin auth rebuild SHALL remain possible
   without undoing this work.

### R7 — Cross-origin access is explicitly controlled

**Story:** As the operator, I need the backend to accept requests only from the frontend, not
from any origin.

**Acceptance criteria**
1. WHEN the backend receives a cross-origin request, THEN it SHALL reflect an explicit
   allowlisted origin and SHALL NOT respond with a wildcard.
2. WHEN credentialed requests are made, THEN `Access-Control-Allow-Credentials` SHALL be set
   and the allowed origin SHALL be exact.
3. WHEN a webhook or cron caller sends a request without an `Origin` header, THEN it SHALL be
   unaffected by CORS policy.
4. WHEN the allowed origins are configured, THEN they SHALL come from env, not be hardcoded.

### R8 — Operational parity on the new host

**Story:** As the operator, I need the cron jobs, rate limits and security headers to behave on
Contabo the way they behave today.

**Acceptance criteria**
1. WHEN the crontab runs, THEN all 16 jobs SHALL target the backend and SHALL authenticate with
   the same `CRON_SECRET` mechanism.
2. WHEN a cron job invokes a route whose `maxDuration` exceeds the runner's `curl -m` timeout,
   THEN the runner timeout SHALL be raised so the job can complete (closes 3.4).
3. WHEN a long-running route is called through the reverse proxy, THEN proxy read timeouts
   SHALL accommodate the route's declared `maxDuration`, up to 300 seconds.
4. WHEN `/api/*` is rate limited, THEN the limits per bucket SHALL match the current
   middleware, and the client IP SHALL be resolved correctly through Cloudflare and the reverse
   proxy rather than collapsing all callers into one bucket.
5. WHEN security headers are served, THEN the headers currently set by middleware SHALL still
   be present on responses, from whichever tier now owns them.
6. WHEN env vars are partitioned, THEN a per-side checklist SHALL be produced from
   `inventory.json`, and no server secret SHALL be present in the frontend build.

### R9 — The remaining coupling is documented, not hidden

**Story:** As a future reader, I need to know that the extraction did not achieve total
separation, and exactly what is left.

**Acceptance criteria**
1. WHEN the extraction is complete, THEN the 44 browser-to-Postgres call sites SHALL be
   documented with their RPCs and tables, and cross-referenced to
   `week1-critical-remediation` task 20.
2. WHEN the extraction is complete, THEN any client that still holds a direct Supabase
   connection SHALL be listed, including the realtime subscriptions.
3. WHEN the extraction is complete, THEN the 2 shared modules and how their duplication is kept in
   sync SHALL be documented, INCLUDING the explicit limitation that a cross-repo CI check cannot
   detect the frontend copy changing (`design.md` §7).
4. WHEN the extraction is complete, THEN `pauto-vault.ts` SHALL be either deleted or given a
   recorded reason to exist, and SHALL NOT be ported by default.

---

## 7. Non-goals

Stated so they are not read in by implication:

- No new product behaviour, no new endpoints, no response shape changes.
- No database migrations. This spec does not touch Postgres.
- No contract changes. The Hardhat project at the repo root is untouched.
- No change to which provider handles a ramp, or to provider selection logic.
- No performance work. If the backend is slower or faster, that is incidental.
