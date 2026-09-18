# PawaSave Mobile — Brainstorm Snapshot

**Date:** 2026-09-18
**Status:** Brainstorm complete, no spec written yet. Flutter scaffold shipped.
**Purpose:** Resume point for a fresh session. Self-contained: assumes no prior context.

---

## 1. What this is

We are building a Flutter mobile app, "social cash for the Nigerian market". The product
sketch, in the founder's words:

- **P2P payments** (send/request) via @handles and emails, plus split-bill requests and
  messages attached to transfers rather than plain notes.
- **Stocks and stock gifting** — buy equity for yourself or for a friend. Believed to be
  largely undone at scale in this market, so it doubles as a distribution edge.
- **Pools** — a revamp of Ajo into themed group savings with contributions and payout
  moments, with the social experience built in.
- **PawaVibes** — animated money and stock gifts. Interactive rather than a bare transfer,
  and sendable to people who are not users yet, who claim from email.

The design and architecture reference is **zendapp**, a previous Flutter project by the same
author at `~/zendfi/zendapp`. Only the parts *actively shown to users* are the reference;
a lot of zendapp is built but unreachable (see §6).

---

## 2. Where we are right now

### Done

The Flutter app is scaffolded, verified and pushed.

- **Location:** `/home/tnxl/Pawasave/pawasave/` — a standalone repo, remote
  `github.com/PawaLabs/pawasave`, branch `main`, tracking set up.
- **Commit:** `067fb0c` — `chore(mobile): scaffold flutter app for android, ios and web`,
  74 files.
- **Config:** Flutter 3.41.3 / Dart 3.11.1, package `com.pawalabs.pawasave`, platforms
  android + ios + web. Desktop targets deliberately skipped.
- The parent `Pawasave` repo gitignores `/pawasave/` (`.gitignore:23`), so the two repos are
  fully independent. Git commands run directly inside `pawasave/`.

**Verified, not assumed:** `flutter analyze` clean, `flutter test` passes, `flutter build web`
succeeds, `flutter build apk --debug` succeeds.

### Environment note worth keeping

The first Android build failed with `[CXX1416] Could not find Ninja`. NDK 28 is installed,
which makes Flutter's Gradle plugin configure CMake, but no `ninja` binary existed anywhere.
Fixed without sudo by installing the SDK's CMake package, which bundles ninja:

```
sdkmanager --install "cmake;3.22.1"   # puts ninja in $ANDROID_HOME/cmake/3.22.1/bin/
```

`sudo apt install ninja-build` is the equivalent. Anyone building Android fresh will hit this.

Also: `flutter doctor` reports the Android toolchain check as crashed. That is a 4.5 minute
timeout on its license/network probe, not a broken SDK. The SDK is healthy (platforms 31-36,
build-tools 34/35, NDK 28).

### Not done

No spec. No app code beyond the template. No backend changes.

---

## 3. Key finding: most of the backend already exists

The single biggest thing learned. This is much more a client build than a backend build.

| Feature | State |
|---|---|
| @handles | **Built.** `supabase/migrations/084_p2p_tags.sql`. Auto-assigned to every signup by `handle_new_user()`, constrained `^[a-z0-9_]{3,20}$`, unique lowercase index. Changed only via `set_user_tag`. |
| P2P send, direct | **Built.** `083_p2p_transfers.sql` + `/api/p2p/send`. Instant, internal ledger, free. |
| P2P send, claim-by-email | **Built.** Same migration. Escrow + invite email to non-users, auto-refunds via the `revert-p2p-claims` cron if unclaimed. This is the PawaVibes money rail. |
| Messages on transfers | **Built.** `p2p_transfers.note`. |
| Handle/email resolution | **Built.** `/api/p2p/resolve`, `/api/p2p/tag`. |
| Pools / Ajo | **Mostly built.** `085` generalised Ajo into "Circles" with `circle_type` (6 values: `rotating_ajo`, `aso_ebi`, `event_dues`, `harambee`, `group_buy`, `chama`) and 3 `payout_mode`s, plus `circle_messages` for per-circle chat. Designed to be extended additively. |
| Stocks | **Built and live**, but risky. See §5. |

### Genuine gaps (greenfield)

1. **Split bills / payment requests.** No primitive at all in PawaSave. `split_rules` is
   unrelated (it auto-splits your own incoming deposits). Cheapest shape: a request is a row,
   a split is N requests sharing a group id. zendapp has the UX to crib.
2. **Social graph.** No `contacts` / `friends` / `follows` table in any of the migrations.
   Recents can be derived from `p2p_transfers`; a real contact book is new.
3. **Stock gifting.** `portfolio_holdings` has no transfer RPC.
4. **Push.** PawaSave has browser Web Push only (`web-push` dep). Flutter needs a new
   FCM/APNs rail.

### Caveat on all of the above

Week 1 remediation tasks 1-3 are open, meaning **nobody has diffed the live production schema
against the migration files.** "Already built" means "in the migrations". Confirm against
prod before relying on it.

---

## 4. The two mechanical blockers

Both found in code. They set the build order.

### 4.1 The Flutter app cannot talk to the Next API

Every user-facing Next route authenticates by cookie. 38 route files under
`frontend/src/app/api/` call `createServerClient` with `cookies()`. The only two files there
mentioning `Authorization` are a webhook and a cron, not user auth.

Bearer token support exists in exactly one place: **`backend/src/compat/auth-user.ts`**, which
accepts either a bearer token or the cookie, and whose own header says bearer is the target
state and the cookie branch exists only so routes can move one wave at a time.

**Consequence:** "the Flutter app feeds from `/backend`" is the only option, not a preference.
Moving the P2P route family into `backend/` is a **prerequisite for the app sending a single
naira.** That work lives in backend-extraction Wave 3 (22 routes after the rebaseline),
currently unstarted. We pull the p2p subset forward.

### 4.2 The parity harness rejects every new route

`backend/test/parity.test.ts`:

```ts
test('no route is registered that the inventory does not know about', () => {
  const known = new Set(inventory.routes.map((r) => r.url))
  const unknown = [...registeredRoutes.keys()].filter((u) => !known.has(u))
  assert.deepEqual(unknown, [], `registered but not in the contract:\n  ${unknown.join('\n  ')}`)
})
```

`backend/spec/inventory.json` is derived from the Next app at commit `8cfa052` (77 routes).
The moment a net-new social route is registered, CI goes red. The gate is correct for its
purpose, proving the extraction invented nothing, but it has no concept of routes that were
never in Next.

**Fix:** a declared `nativeRoutes` list in `backend/spec/baseline.json` that the gate excludes.
Keeps the extraction proof intact while giving new work somewhere to live. Do **not** simply
regenerate `inventory.json` — that destroys the provenance trail the baseline exists to hold.

Also: `gate 3` (env coverage) is enforced from day one. Any new env var, e.g. FCM credentials,
must land in `backend/.env.example` via `npm run ops:env` or CI fails.

---

## 5. Architecture decisions taken

- **Auth: bearer, not cookies.** `supabase_flutter` for sign-in, take
  `session.accessToken`, send `Authorization: Bearer`. Backend-extraction task 27 is
  "delete the cookie auth fallback", so cookies are on the way out.
- **Reads direct from Supabase under RLS. All writes through server routes.** This is the
  existing posture and it is deliberate; client write policies were stripped in migration
  `080`. One subtlety to respect: the user-scoped client uses the **anon key plus the user's
  JWT, never the service role**, because ~63 `SECURITY DEFINER` functions do their own
  `auth.uid()` checks. A service-role client satisfies the grant and silently skips every one.
- **Never write ledger rows from the client.** F1 is still open: `transactions` INSERT remains
  client-writable, and migration `080`'s own comment says the ledger "cannot be treated as
  trustworthy for reconciliation" until that is fixed. Do not add a second client author.
- **Build the activity feed on `p2p_transfers`, not `transactions`.** The former is
  server-authored and clean. This likely means the v1 feed shows social money only, not every
  ledger event. Deliberate tradeoff.
- **API base URL behind one config value from the first commit.** Backend-extraction task 28
  is a wave-by-wave cutover to OVH; the host serving these routes will move under us.
- **State management: Riverpod.** Explicitly *not* zendapp's approach (see §6).
- **New backend routes are native Hono**, typed, bearer-only, no `cookies()`. The extracted
  routes are byte-identical copies of their Next originals and must stay that way; new routes
  have no original. Keep them in a separate directory so the distinction stays visible.

### Stocks: why it goes last

The equity stack is a DIY on-chain brokerage, not a broker API. Coinbase tokenized US stocks
on Base, bought in two legs (cNGN → USDC via HyperFX, then USDC → stock on Aerodrome or
Uniswap), omnibus custody under a single server-held key. See `frontend/src/lib/equity-broker.ts`.

Three facts that matter for product design:

1. Orders take 1-2 minutes and have **three** outcomes: `filled`, `failed` (refunded), and
   `settling` (money moved, order unfinished, a cron will finish it). Mobile must surface
   `settling` as a real state.
2. The **buy path has no fair-value floor and no per-order cap** (the audit recommends ₦200k).
   The sell path does have a floor. The asymmetry sits exactly where a gift would land.
3. The tokens are **Reg S, non-US persons only**, and the issuer can freeze wallets in
   prohibited jurisdictions.

**Recommendation on stock gifting:** holding an equity position for someone with no account
and no KYC is a different risk class from holding cash in escrow. Either make the gift
*cash with a stock intent* that converts on claim under the recipient's own KYC, or restrict
stock gifts to existing verified users. Let **cash** gifting carry the viral non-user loop, so
the stock gift becomes the thing worth signing up for.

---

## 6. zendapp: what to take, what to leave

`~/zendfi/zendapp` — a Flutter app, 220 Dart files, ~86,500 lines. Design spec is
`redesign.md` (~2,900 lines, "ZEND BETA v1.0").

### PawaVibes already exists there

~1,550 lines across `lib/src/features/vibes/`: money hidden inside a sticker, revealed on
tap, server-driven sticker catalog with a local fallback. Currently live **inside DM threads**
and deliberately gated off in the global entry sheet behind a "coming soon" dialog. Pair that
UI with PawaSave's claim-escrow rail and PawaVibes is the two halves meeting. The escrow's
auto-revert is good gift semantics: an unclaimed gift goes home by itself.

### Three patterns worth stealing outright

1. **One verb, one sheet.** `lib/src/features/shell/zend_entry_sheet.dart`. Three spec'd
   screens (identity → found → send/request) were merged into a single two-stage sheet: pick a
   person, type an amount, then choose Request / Send / Vibe. Send is not a tab, it is a
   floating action. **Wallet is not a tab either**, it is a sheet off the balance. That last
   one is a strong opinion and right for social cash: relationships are primary, not the
   wallet. The file carries a "layout contract (do not break)" header explaining why the sheet
   is bounded-height; worth reading before reimplementing.
2. **Two-tap confirm only on the irreversible action.** Send arms into a button reading
   `Send ₦X to @tag`. Request is one tap, no confirm, because a request is not destructive.
3. **Outcome in a banner, not in the sheet.** The sheet closes immediately on commit; the
   result lands in a shell-level banner with inline Retry carrying amount, recipient and note.
   State lives *above* the navigator so it survives the sheet being gone. Handles
   sending / sent / failed / **uncertain** — which is already the right home for equity's
   `settling` state.

Also portable: the `ApiClient` Dio interceptor shape (token from secure storage per request,
typed `ApiException` from `{error, message}`, connection-error classification, one global
`onUnauthorized` → model reset → root-nav sign-out); `AuthService`'s three-state session
validation and "route off local token, validate unawaited after first paint" launch pattern;
the whole `lib/src/design/` folder structure including `skeleton_loader.dart`.

### What to avoid

- **The state management.** One 2,060-line god `ChangeNotifier` behind an `InheritedNotifier`.
  Because an `InheritedNotifier` cannot narrow, they hand-rolled a `ZendSelector` to avoid
  rebuilding the world on every notify. It works; it is a tax Riverpod removes.
- **`api_client.dart`** — 2,673 lines with ~100 hardcoded endpoint literals in one class.
  Copy the interceptor, not the class.
- **Hardcoded base URL** (`const kApiBaseUrl` in `main.dart`) instead of build-time config.
- **Leaving a superseded shell in the tree.** `home_screen.dart`, `send_screen.dart`,
  `activity_screen.dart` and the entire OTP onboarding chain are unreachable dead code that
  still compiles, and `docs/screen-flow-map.md` now describes an app that no longer exists.

### Built but hidden in zendapp (do not mistake for live)

The pre-redesign shell (Money/Send/Activity tabs) and everything reachable only from it,
including a social-graph visualisation; the whole phone/OTP signup chain (live path is Google
zkLogin only); Zend Drop (BLE/NFC proximity transfer, ~15 files, receiver half still fires
from an SSE event); Cards; Savings and PublicFeed screens reachable only from notification
taps.

Nothing in zendapp implements split bills.

---

## 7. Design system

The two systems already agree on the core rule, which is convenient.

**Use PawaSave's `.ps` tokens** from `frontend/src/app/globals.css`, not zendapp's palette.
Mirror them into a Flutter theme, borrowing zendapp's *structure* (a hand-rolled
`ZendTheme.of(context)` token record rather than fighting `ColorScheme`).

Light theme essentials:

```
--bg:#F2F5F1   --surface:#FFFFFF  --surface-2:#F8FAF7
--ink:#131A15  --muted:#69726C    --faint:#9AA39C
--line:#E7EBE5 --green:#0A6B42    --green-soft:#E8F3ED
--pos:#0A6B42  --neg:#C0483C      --amber:#C77C1E
--hero:#131A15 --on-hero:#FFFFFF  --on-hero-muted:#A8B0AA
```

- **Type:** 8 steps, 11px floor, no fractional values — 11/12/13/14/16/20/28/36.
- **Weights:** only 400/500/600/700. The variable font snapped 650/680 to 700, which flattened
  hierarchy. At ≤12px, 500 is the floor.
- **Spacing:** 4px base (4→40). **Radius:** 8/12/16/22/full. **Elevation:** 3 steps.
- **Motion:** 120/200/320ms, `--ease-out: cubic-bezier(.2,.7,.2,1)`,
  `--ease-spring: cubic-bezier(.34,1.4,.64,1)`. The spring is the PawaVibes easing.
- **Money figures:** tabular numerals with -0.02em tracking. In Flutter,
  `FontFeature.tabularFigures()` plus `letterSpacing: -0.02 * fontSize`.
- **Font:** Inter.

Two rules written into the CSS, worth honouring: *green means one thing*, positive movement
and primary action, never chrome or wallpaper; and hero surfaces are solid near-black
(`--hero`), deliberately not the accent.

Borrow one more from zendapp: **debits render near-black, not red**, so a routine debit does
not read as an alarm. Red is reserved for genuinely destructive actions. Good fit for social cash.

Known discrepancy: zendapp's own `redesign.md` specified warm ivory with a vermilion accent,
and the implementation shipped green anyway. Code and spec disagree there. Follow `.ps`.

---

## 8. Modus operandi

- **Backend-first, per vertical slice.** Never write Dart against an endpoint that does not
  exist. Each slice: agree the JSON contract → build and test the route in `backend/` → then
  the Dart model and UI.
- **One spec per slice** in `.kiro/specs/`, requirements → design → tasks, matching the three
  existing specs.
- **Money writes keep the existing discipline:** server route authenticates the caller, then a
  `SECURITY DEFINER` RPC under `FOR UPDATE` moves balances, idempotent on a `reference`.
- **Verification per slice:** `npm run typecheck && npm test` in `backend/` (parity gates
  included), `flutter analyze && flutter test` in the app. Both work today.
- **Commits:** `type(scope): subject`, lowercase, imperative, under ~70 chars, per
  `.kiro/steering/code-style.md`. New scope: `mobile`. Reference the spec task in the body
  since `.kiro/` is gitignored and never appears in a commit.

---

## 9. Build order

### Phase 0 — unblock (backend)

1. Parity gate escape hatch (`nativeRoutes` in `baseline.json`). Unblocks everything after it.
2. Move `/api/p2p/resolve` and `/api/p2p/tag` into `backend/` first. Reads, so they prove the
   bearer path end to end against real data at low risk.
3. Move `/api/p2p/{send,pending,claim,cancel}`. Test the money paths hard.
4. FCM/APNs push rail (new; Web Push is useless to mobile).
5. API base URL as a single config value in the Flutter app.

### Phase 1 — identity and the money spine

`supabase_flutter` auth with bearer + secure-storage session. `.ps` tokens ported to a Flutter
theme. App shell: tabs plus floating action. Claim-your-handle moment (`handle_new_user()`
auto-assigns ugly ones; zendapp has `zendtag_prompt_sheet.dart` for exactly this). The entry
sheet, and the outcome banner built properly — it is where `settling` will live later.

### Phase 2 — the social layer

Feed on `p2p_transfers`. Recents derived from transfer history before any real contact graph.
Notes already exist in schema, so messages-on-transfers is free.

### Phase 3 — requests and split bills

First genuinely new backend primitive.

### Phase 4 — PawaVibes

Gift metadata and sticker catalog on the claim rail, reveal animation ported from zendapp,
plus a web claim page on the Next app so non-users collect without installing first.

### Phase 5 — Pools

Mostly client work; `085` and `circle_messages` already exist.

### Phase 6 — stocks and gifting

Last, deliberately. Needs the per-order cap and buy-side floor first.

---

## 10. Open questions (blocking spec work)

1. **The CBN cap.** The founder cited "$2,000 in one go". This does not match the code:
   everything is domestic naira (cNGN, naira wallets, NUBAN) and `/api/p2p/send` already
   enforces **₦3M/day on `lite`** (BVN + NUBAN) and **₦10M/day on `full`**. Either the figure
   refers to a cross-border/FX regime that does not apply to domestic NGN P2P, or tighter caps
   are wanted than what is implemented. **Unresolved — needs a decision, and a compliance
   answer rather than a guess.** It directly sets the limit policy in the send route.
2. **Pools: rename or seventh `circle_type`?** Is "Pools" the consumer-facing name for all of
   Circles, or a new type alongside the existing six? Cheap either way; it decides the IA.
3. **PawaVibes claim: web page or app install required?** Recommendation is web claim then
   upsell the install, since the distribution edge is the whole point.
4. **v1 slice confirmation.** Proposed: P2P send/request + @handles + notes + activity feed +
   PawaVibes cash gifts. One coherent product, all on mature rails, and it is the viral loop.
   Stocks and Pools follow as two and three.

---

## 11. Repo and environment reference

| Thing | Where |
|---|---|
| Flutter app | `/home/tnxl/Pawasave/pawasave/` → `github.com/PawaLabs/pawasave` (standalone) |
| Parent monorepo | `/home/tnxl/Pawasave/` → `github.com/Perry0404/Pawasave` |
| Backend (Hono, port 3100) | `backend/` — separate git repo, 113 TS files |
| Live API surface (today) | `frontend/src/app/api/**` — 76 route files, cookie auth |
| Migrations | `supabase/migrations/` — 76 files, numbered to `086`, applied by hand |
| Design reference | `~/zendfi/zendapp` (Flutter), spec in its `redesign.md` |
| Design tokens | `frontend/src/app/globals.css`, `.ps` scope |
| Equity implementation | `frontend/src/lib/equity-broker.ts` |
| Bearer auth shim | `backend/src/compat/auth-user.ts` |
| Parity gates | `backend/test/parity.test.ts`, contract in `backend/spec/` |

**Note:** `.kiro/` is gitignored (`.gitignore:26`), so specs and steering do not travel with
the repo. This file lives at the repo root so it does.

### Related reading, already in the repo

- `PAWASAVE_AUDIT_2026-09_AND_PLAN.md` — 8 Critical / 14 High / 21 Medium. Read before
  building on any subsystem.
- `.kiro/specs/backend-extraction/tasks.md` — open: 10, 14 (Wave 3), 18 (Wave 7), 19, 20, 21,
  27, 28, 29, 30.
- `.kiro/specs/week1-critical-remediation/tasks.md` — open: tasks 1-3 (prod schema never
  captured or diffed), 17, 18, 21, F1-F5.
- `AUDIT_V2_REMEDIATION.md` — 5 contract fixes are in source but need the v3 redeploy.

### Scale, for proportion

Measured in production at audit time: **44 registered users, 4 wallets holding money,
₦3,331 total customer money.** Remediation and rebuilding are happening before scale, which
is the cheapest possible time.
