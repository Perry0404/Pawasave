# Backend Extraction: Design

**Spec:** `backend-extraction` · **Requirements:** `requirements.md` · **Inventory:** `inventory.json`

---

## 1. Target topology

Today one Next.js process on Coolify/Hetzner serves UI, API and cron targets. After the
extraction there are two processes, deployed to Contabo independently.

```
                    Cloudflare
                        │
                    nginx (TLS)
            ┌───────────┴───────────┐
   pawasave.xyz                api.pawasave.xyz
   frontend (Next)             backend (Hono/Node)
   :3000                       :3100
   pages, RSC, static          64 × /api/* routes
                                    │
   host crontab ───────────────────►┘  (BASE_URL=http://127.0.0.1:3100)
                                    │
                        Supabase ◄──┘──► Base L2 RPC, Flipeet, StraiLs, Xend, HyperFX
```

The frontend keeps the apex, which is what `site-url.ts` already falls back to
(`https://pawasave.xyz`) and what is baked into auth redirect and invite links. The backend takes
`api.pawasave.xyz`. The admin cookie gets `Domain=.pawasave.xyz`, which covers the apex and every
subdomain.

Apex plus subdomain is load-bearing, not cosmetic: the two origins are **same-site**, which is
what lets the admin session keep its `httpOnly` cookie (§5.2). Putting the API on a different
registrable domain would force the admin token into JavaScript-readable storage and regress
`V2-HIGH-03`.

The frontend keeps `/auth/callback`. It is a browser redirect flow that exchanges an OAuth or
OTP code and writes the Supabase session cookie; it must run on the origin the user is browsing.
It is the one route file that does not move, which is why the inventory counts 65 routes but the
backend owns 64.

## 2. Framework: Hono

This revises an earlier suggestion of Fastify. The inventory made the case for a Web-standard
framework decisively.

Next route handlers already receive a Web `Request` and return a Web `Response`. `NextRequest`
extends `Request`; `NextResponse.json()` is `Response.json()` with extras. Measured across all
65 route files:

| Handler shape | Count |
|---|---|
| Typed `NextRequest` or bare, using only Web `Request` APIs | **56** |
| Genuinely Next-specific (`nextUrl`, `request.cookies`, `NextResponse.redirect`) | **9** |

Those 9 are `admin/revenue-withdraw`, `flipeet-webhook`, `invest/quotes`, `p2p/resolve`,
`proxy`, `ramp/resolve-account`, `ramp`, `strails-webhook`, `ussd`. Each needs a one-line
substitution: `req.nextUrl` becomes `new URL(req.url)`, `req.cookies.get(n)` becomes a parse of
the `Cookie` header.

Under Hono a handler is `(c) => Response`, and `c.req.raw` is a real `Request`. So every moved
handler keeps its existing body verbatim and gets a two-line registration wrapper. Under Fastify
the model is Node `req`/`reply`: all 65 handlers would need `NextResponse.json(x, {status})`
rewritten to `reply.code(status).send(x)`, `await request.json()` to `request.body`, and
`request.headers.get(k)` to `request.headers[k]`. That is 65 files of hand edits in code that
moves money, against R4's requirement that logic be untouched.

Hono is chosen because it minimises the diff, not because it is faster. `hono` v4.12.x with
`@hono/node-server` v2 on Node 22 to match the existing Dockerfile.

Trade-off accepted: Hono is less familiar than Express or Fastify to most Node developers, and
its ecosystem of third-party middleware is smaller. Both costs are low here because the backend
needs very little middleware, and they are outweighed by not hand-editing 65 payment handlers.

## 2a. Two repositories

`backend/` is its own git repository, sitting inside the `Pawasave` working directory and excluded
from the parent via `.gitignore:21` (`/backend/`). This is deliberate and it constrains four things
that a single-repo design would get for free.

**History does not follow the files.** `git mv` cannot preserve history across a repository
boundary, so R4.5 cannot be satisfied by moving. Two options were considered:

| Approach | Cost | Verdict |
|---|---|---|
| `git filter-repo` to extract the history of `frontend/src/lib` and `frontend/src/app/api` into the backend repo | Complex, rewrites paths, easy to get subtly wrong across 93 files | Rejected for now |
| Clean initial commit recording the exact source commit, with provenance carried by the normalised diffs | Loses `git log` per file | **Chosen** |

Provenance is preserved where it actually matters: every moved file has a normalised diff on record
(§11) proving it is byte-identical to a named commit, and the backend's initial commit names that
commit. That is stronger evidence of faithfulness than a `git log` would be. If per-file history is
wanted later, `filter-repo` can graft it in without invalidating any of this work.

**The contract must be vendored.** The parity gates read `inventory.json`, which lives in
`.kiro/specs/backend-extraction/` in the parent repo. The backend repo's CI cannot see it, so a
copy lives at `backend/spec/inventory.json`, refreshed by re-running the generator. A staleness
check compares its recorded source commit against the backend's own baseline.

**CI is per-repo.** The parent's `.github/workflows/ci.yml` cannot test `backend/`. The backend
repo gets its own workflow running typecheck, the parity gates and a dependency audit. The
"`frontend/src/app/api/` is empty" check stays in the parent's workflow, since that is where the
frontend lives.

**Deploys are not atomic across the boundary.** A frontend that points at a backend route which is
not yet live is an outage. Ordering is therefore fixed: register and deploy the backend route
first, verify it serves, then repoint the frontend. Every wave in §12 follows that order, and it is
the reason nginx path-routing matters so much here (§12) — it lets the backend serve a wave before
the frontend knows about it.

## 3. Directory layout

```
backend/                  ← its own git repository, gitignored by the parent
  package.json            no next / react / react-dom
  tsconfig.json           noEmit:false, outDir:dist, paths { "@/*": ["./src/*"] }
  Dockerfile              modelled on frontend/Dockerfile, keeps .hyperbridge-cache fix
  .env.example            generated from inventory.json serverEnv
  .github/workflows/ci.yml  own CI: typecheck, parity gates, dependency audit
  spec/
    inventory.json        vendored contract copy, the parity gates read this
  src/
    server.ts             bootstrap: env check, CORS, rate limit, routes, listen
    routes/               mirrors the old app/api tree 1:1
      admin/…  cron/…  esusu/…  invest/…  p2p/…  ramp/…  strails/…  wallet/…
    lib/                  the 29 server-only modules, paths unchanged
    compat/               the adapter layer (§4)
      response.ts         NextResponse-shaped helpers over Web Response
      cookies.ts          cookies() replacement
      auth-user.ts        user identity from bearer or cookie
      auth-admin.ts       admin session, httpOnly cookie preserved
      cron-auth.ts        de-Nexted CRON_SECRET gate
  test/
    parity.test.ts        R3 gates
```

`paths: { "@/*": ["./src/*"] }` is kept identical to the frontend's alias so that a moved file's
`@/lib/custody` import resolves without edit. This is the single highest-leverage decision for
keeping diffs small: without it, every one of the 29 lib modules and 64 routes would need its
import block rewritten.

Build is `tsc` plus `tsc-alias` to rewrite the aliases in emitted JS. No bundler.

## 4. The compat layer

This is how R4 is satisfied. Rather than edit handlers to suit a new framework, the framework is
made to present the surface the handlers already expect.

**`compat/response.ts`** exports a `json(body, init?)` that returns a Web `Response`, matching
`NextResponse.json`'s signature. Moved handlers change their import and nothing else:

```ts
// before:  import { NextResponse } from 'next/server'
// after:   import { NextResponse } from '@/compat/response'
```

Keeping the exported name `NextResponse` is intentional. It is mildly odd to read, but it means
the ~400 `NextResponse.json(...)` call sites across 64 handlers are untouched, so the normalised
diff required by R4.3 stays empty for those lines. A rename is a cosmetic follow-up, not part of
this move.

**`compat/cookies.ts`** provides an async `cookies()` returning `getAll`/`get`, built from the
request's `Cookie` header, so the `@supabase/ssr` call sites that do
`createServerClient(url, key, { cookies: { getAll } })` keep working verbatim. Request context is
carried by `AsyncLocalStorage` so `cookies()` needs no argument, exactly as in Next.

**`compat/cron-auth.ts`** keeps `checkCronAuth(request)` returning a `Response` or `null`, so the
25 cron and probe routes keep their `const denied = checkCronAuth(req); if (denied) return denied`
shape.

## 5. Authentication

The two session types get different treatments because they have different threat models. This
is a deliberate asymmetry, documented here so it is not read as an inconsistency.

### 5.1 User sessions: bearer token, cookie fallback during migration

Target state: the browser sends `Authorization: Bearer <supabase access token>`. The backend
builds a per-request Supabase client with that token and calls `getUser()` to establish identity.

This does not weaken anything. The access token is already reachable from browser JavaScript via
`supabase.auth.getSession()`, so moving it from a cookie to a header changes no attacker
capability. What it buys: no cross-origin cookie handling on the hot path, and an API that a
mobile client can call later without a browser.

The critical constraint is R5.2. The token must be **forwarded to Supabase**, not swapped for
the service role:

```ts
createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${token}` } },
  auth: { persistSession: false },
})
```

This keeps RPCs executing as `authenticated` with the correct `auth.uid()`. It matters because
`week1-critical-remediation` task 20 revokes `anon` and narrows grants to `authenticated`; a
backend that reached for the service role instead would bypass every `auth.uid()` check inside
the 63 `SECURITY DEFINER` functions and turn an authorization layer into decoration.

Routes that use the service role today keep using it (R5.3). The extraction does not
re-litigate any route's choice of client.

During migration `compat/auth-user.ts` accepts **either** the bearer token or the session cookie,
so routes can move one domain at a time while the frontend is still sending cookies. The cookie
path is deleted once the last domain has moved, and that deletion is an explicit task, not a
cleanup left to chance.

### 5.2 Admin sessions: keep the httpOnly cookie

The admin token stays in an `httpOnly` cookie. It was put there deliberately to stop an XSS
payload from stealing it and draining revenue (`V2-HIGH-03`), and a bearer token in
JS-reachable storage would undo that.

One attribute changes. The cookie is currently host-only, so it would not be sent to
`api.pawasave.x`. It gains `Domain=.pawasave.x`. Because both hosts are under one registrable
domain they are same-site, so `SameSite` does not need weakening and `Secure` and `httpOnly` are
untouched. The widened scope means any subdomain can now receive the cookie, which is acceptable
only while every subdomain is ours; that condition is recorded as an operational constraint.

Cross-origin credentialed requests additionally need `credentials: 'include'` on the client and
an exact `Access-Control-Allow-Origin` plus `Access-Control-Allow-Credentials` on the server
(R7). A wildcard origin is not permitted and would be rejected by the browser for credentialed
requests anyway.

The password-in-body fallback currently accepted by admin routes is **left in place**. Removing
it is a behaviour change and belongs to `P3-H-08`, not here.

## 6. Rate limiting and headers

The 93-line middleware splits by tier.

| Concern | New owner | Note |
|---|---|---|
| CSP, X-Frame-Options, Referrer-Policy, HSTS, Permissions-Policy | frontend middleware, unchanged | they protect HTML, not JSON |
| `/api/*` rate limiting | backend, as Hono middleware | same buckets: admin 10/min, ramp 15/min, other 30/min |
| API response headers | backend | `nosniff`, HSTS on API responses too |

The limiter keys on client IP. Behind Cloudflare and nginx, `x-forwarded-for` is a list and the
right entry must be selected against a trusted-proxy configuration, otherwise every caller
collapses into a single bucket and the limit becomes global. `CF-Connecting-IP` is preferred when
present and Cloudflare is confirmed in front. The existing Upstash Redis backend and in-memory
fallback port across as-is, including the fail-open behaviour, which is retained because
changing it is a behaviour change.

## 7. Shared modules

Only 2 of 39 lib modules are genuinely shared, each with exactly one server importer:

| Module | Server importer | Resolution |
|---|---|---|
| `contracts.ts` (146 lines, addresses + inline ABIs) | `lib/yield/aggregator.ts` | duplicate into `backend/src/lib/` |
| `site-url.ts` (26 lines) | `lib/notify-tx.ts` | duplicate into `backend/src/lib/` |

Duplication beats an npm workspace here. A workspace adds a build graph, a hoisting story and a
publish or linking step to save 172 lines of copying. If a third or fourth module becomes shared,
revisit.

The cost of duplication is drift, and the two-repo split (§2a) makes it harder to police: a CI job
in the backend repo cannot read the frontend's copy. So the check is weaker than a diff and the
limitation is stated rather than papered over. Each vendored copy carries a header recording the
source commit and a SHA-256 of the original, and CI verifies the local file still matches the
recorded hash. That catches an accidental local edit to the backend copy, which is the common
failure. It does **not** catch the frontend's copy changing, which is the failure that actually
matters.

For that, the mitigation is procedural and belongs in the frontend repo: `contracts.ts` and
`site-url.ts` carry a comment naming the backend as a consumer, so a reviewer touching them knows
to sync. Both files are stable by nature, chain addresses and a base URL, so the exposure is small.
If either starts changing often, promote them to a published package.

`contracts.ts` reads chain config from `NEXT_PUBLIC_*` variables. The backend keeps those names.
Renaming them is a behaviour change with a deployment-config blast radius, so it is filed as a
follow-up rather than bundled in.

`pauto-vault.ts` has zero importers and is not ported. It is deleted, with the deletion in its
own commit so it is trivially revertible.

## 8. Env partition

122 server env vars are in play. `.env.example` for the backend is generated from
`inventory.json` rather than written by hand, and R3.3 asserts the generated template covers
every var the code reads.

Three categories need care:

- **`NEXT_PUBLIC_*` read server-side.** Several server modules read `NEXT_PUBLIC_BASE_RPC_URL`
  and friends. The backend needs these names present in its own env despite the misleading
  prefix. Documented, not renamed (§7).
- **Build-time versus runtime.** The frontend inlines `NEXT_PUBLIC_*` at build time. The backend
  reads everything at runtime and must never bake a secret into its image, the same rule the
  existing `frontend/Dockerfile` header states.
- **Secrets that move wholesale.** `CUSTODY_PRIVATE_KEY`, `DEPOSIT_WALLET_MNEMONIC`, all keeper
  keys, `SUPABASE_SERVICE_ROLE_KEY`, every provider API key. After the split these must be
  **removed** from the frontend's environment, not merely also-present on the backend. Leaving
  them configured on the frontend host keeps the blast radius the extraction is meant to shrink.

`@hyperbridge/sdk` moves to the backend, which lets the frontend return to `npm ci` against a
strict lockfile (R2.5). The `.hyperbridge-cache` writable-directory workaround in the current
Dockerfile moves with it.

## 9. Cron

`ops/cron/` needs three changes and no redesign.

1. `cron.env` — `BASE_URL` points at the backend, `http://127.0.0.1:3100`.
2. `pawasave-cron.sh` — `curl -m 120` is raised. Four routes declare `maxDuration=300`
   (`cron/equity-buy-reconcile`, `cron/equity-sell-reconcile`, `cron/scan-crosschain-deposits`,
   and the equity paths they drive). Today those jobs are cut off at 120 seconds and reported as
   failures to healthchecks.io. The runner timeout goes to 310 and nginx `proxy_read_timeout`
   matches. This is the one pre-existing defect fixed in-flight, because carrying it into new
   infrastructure would be knowingly shipping a break (R8.2).
3. The crontab paths are unchanged, because §3 preserves URLs exactly. R3.4 asserts every path in
   the crontab resolves to a registered backend route.

Cron concurrency is already solved and needs nothing: the DB fencing lease in `custody-lease.ts`
(`try_acquire_lease`, `refresh_lease`, `release_lease`) serialises every custody signer, so
overlapping runs are safe. This is why a single-instance assumption is not baked in anywhere.

## 10. Parity gates

R3 is enforced by `backend/test/parity.test.ts`, reading `inventory.json` as the contract. Four
assertions, all mechanical:

1. **Route coverage** — every URL in the inventory is registered. Hono exposes its route table,
   so this is a set comparison, not a guess.
2. **Method parity** — registered methods per route match the inventory exactly, both directions.
3. **Env coverage** — every `serverEnv` entry appears in `.env.example`.
4. **Cron reachability** — every path in `ops/cron/crontab` resolves to a registered route.

Plus a repo-level check that `frontend/src/app/api/` holds no `route.ts`, so nothing is left
behind or later re-added. All of it runs in CI and blocks merge.

These gates are the reason the move can proceed domain by domain with confidence. At any point
the gate reports exactly which routes have not yet landed, so "did we miss one" stops being a
judgement call.

## 11. Faithfulness verification

R4 needs evidence per moved route, so each move produces a normalised diff: original versus
moved, with import lines, the registration wrapper, and route segment config excluded. The
expected result is empty. A non-empty diff must be justified in the commit body or reverted.

This is what makes "not a rewrite" checkable rather than aspirational. It also keeps review
tractable: a reviewer reads the normalised diff, not 1432 lines of `/api/ramp`.

## 12. Cutover sequence

Routes move in ascending blast-radius order, so the risky ones move last with the most practice
and the most tooling proven.

| Wave | Domains | Why here |
|---|---|---|
| 1 | `invest/quotes`, `invest/ngx`, `ramp/rate`, `ramp/banks`, `ramp/status` | unauthenticated reads, trivially verifiable, proves the harness |
| 2 | `wallet`, `push`, `security`, `statement`, `welcome`, `esusu` | authenticated but not money-moving |
| 3 | `p2p`, `savings`, `loans`, `kyc`, `strails`, `proxy`, `ussd` | money-moving, single-provider |
| 4 | webhooks: `webhook`, `flipeet-webhook`, `xend-webhook`, `strails-webhook`, `kyc/webhook` | external callers, needs URL coordination |
| 5 | `cron/*` (16 jobs) | switch `BASE_URL` once, all at once |
| 6 | `admin/*` | needs the cookie Domain change |
| 7 | `invest/equity`, `invest/getequity`, `xend`, `ramp` | highest value at risk; `ramp` is 1432 lines |

nginx routes by path prefix, so a wave can be pointed at the backend while everything else still
hits Next. That gives per-wave rollback by reverting one nginx location block, which is the only
rollback mechanism available given there is no staging environment.

Webhooks in wave 4 are the one irreversible-ish step: provider callback URLs are registered
externally. Where a provider supports it, point the callback at the backend and keep the Next
route alive until traffic is confirmed moved, then retire it.

## 13. Risks

| Risk | Mitigation |
|---|---|
| No staging environment to catch a regression | Wave-by-wave cutover with per-wave nginx rollback; normalised diffs; parity gates in CI. `week1-critical-remediation` tasks 11 and 12 create a staging environment; if they land first, use it |
| `/api/ramp` at 1432 lines is too large to review | Not refactored. Normalised diff must be empty, so review is of the wrapper only |
| Auth change breaks `auth.uid()` in RPCs | R5.2 forwards the user JWT; a wave-1 route exercises an `authenticated` RPC before any money route moves |
| Overlap with `week1-critical-remediation` task 20 | Do not start wave 3 until task 20 has landed and been verified |
| Secrets left configured on the frontend host after the split | Explicit removal task with a verification step, not a documentation note |
| Cloudflare or nginx misconfiguration collapses rate-limit buckets | Verify the resolved client IP with a probe endpoint before relying on the limiter |
| `NEXT_PUBLIC_*` names on a non-Next server confuse future operators | Documented in `.env.example`; rename filed as a follow-up |

## 14. Deliberately not done

- No npm workspace or shared package (§7).
- No rename of `NEXT_PUBLIC_*` server-side vars (§8).
- No `/api/ramp` refactor (§13).
- No removal of the admin password-in-body fallback (§5.2), owned by `P3-H-08`.
- No change to the browser-to-Postgres path (requirements §4, R9), owned by
  `week1-critical-remediation` task 20.
- No change to the rate limiter's fail-open behaviour (§6).
