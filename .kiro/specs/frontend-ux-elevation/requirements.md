# Frontend UX Elevation: Requirements

**Spec:** `frontend-ux-elevation`
**Source:** Frontend UI/UX audit, 08 Sep 2026 (this spec is the audit's record — there is no separate audit document)
**Branch under change:** `audit-v2-remediation-and-flint-onramp`
**Finding namespace:** `UX-nn` (`FIND-FE-*` and `V2-FE-*` are already used by the security audits)
**Status:** Requirements — awaiting review before design

---

## 1. Objective

Make the PawaSave consumer app feel like a product people trust with their money, without redesigning it.

The audit found something that changes the shape of this work. The `.ps` design system in `globals.css` is sound, and five of six main views use it faithfully. The app does not need a new design language. It needs three things the current one is missing:

| | What exists | What is missing |
|---|---|---|
| **Foundation** | Colour tokens, light/dark themes, one shadow | A working webfont, and scales for type, space, radius, motion, elevation |
| **Coverage** | 5 of 6 views fully tokenised | `home-view` — which owns Send and Receive |
| **Interaction** | One entrance animation | Focus, feedback, optimistic writes, skeletons, real dialogs, motion |

That framing matters because it sets the cost. This is completion and deepening, not a rewrite, and the highest-impact item in the entire spec is a six-character change.

## 2. Scope

**In scope**
- The `.ps` design system token layer and its consumers
- All six main views, the auth screen, the join deep-link page, and the gating screens (PIN, biometric, KYC)
- Navigation structure and routing
- Feedback, loading, error and empty states
- Accessibility to WCAG 2.1 AA for the consumer app
- The money-movement confirmation and receipt path
- PWA install and platform integration polish

**Out of scope**
- `/protocol` and `/admin`. Both are internal or advanced surfaces with their own `.proto-*` vocabulary. They are noted where they cause confusion (`UX-39`) but are not being restyled.
- The static marketing and legal pages (`/about`, `/terms`, `/privacy`, `/whitepaper`) beyond brand consistency.
- Any change to API contracts, database schema, or contract code, **except** `UX-13`, which requires the withdrawal quote to be server-authoritative. That one is in scope because a confirmation screen that disagrees with the backend is the worst class of bug this spec could introduce.
- New product features. Merging Save/Invest/Borrow into one destination (`UX-20`) reorganises existing capability; it does not add any.

**Visual language changes that are in scope, deliberately.** R15 and R16 are the two places this spec does change the approved look rather than only completing it: gradient surfaces become solid with a neutral-dominant palette, and the two icon systems become one. Both were directed decisions, both are recorded as requirements so they are reviewable, and both are sequenced into Phase 1 because they alter the token layer everything else consumes.

**Explicitly not a goal:** visual novelty. Outside R15 and R16, every change either fixes something measurably broken, removes drift, or adds a missing interaction primitive. Novelty is specifically rejected in icon metaphors for navigation and primary actions, where recognition speed matters more than freshness (R16.4).

## 3. Reconnaissance already completed

Four facts were established before writing this spec, because each one changes what the work is.

### 3.1 — The webfont never reaches the app. Proven from build output.

`layout.tsx:7` calls `Inter({ subsets: ['latin'] })` and applies `inter.className` to `<body>`. Both correct. But `next/font` self-hosts under a generated family name and does **not** register the literal family `Inter`.

Extracted from the committed `.next` build:

```
$ grep -o "@font-face{[^}]*}" .next/static/css/*.css | grep -o "font-family:[^;}]*" | sort -u
font-family:__Inter_f367f3
font-family:__Inter_Fallback_f367f3
```

Eight `@font-face` blocks, all under the generated names. **Zero** under `Inter`. And `globals.css:80` ships:

```
--sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif
```

`.ps` is a class selector on the app container, so it overrides the inherited `body` font. The literal `Inter` does not resolve, and the whole consumer app falls through to `ui-sans-serif`.

*Consequences, in order of importance:*

1. The app renders in Roboto on Android and SF on iOS. The auth screen and `/protocol` sit outside `.ps` and **do** get real Inter, so users see the typeface change at login.
2. The system uses weights `600, 650, 680, 700, 800`. Inter-as-variable-font supports all of them; Roboto and SF do not, so `650` and `680` snap to `700`. **This is the root cause of the flat typographic hierarchy**, not the global `font-weight` rules alone. The intended three-step ramp collapses to two.
3. Any type-scale work done before this fix is calibrated against the wrong font and will need redoing.

This is why R1 blocks R2.

### 3.2 — `home-view` is the only view that was never migrated, and it is the one that matters most.

Counting hardcoded light-theme Tailwind classes per view:

| View | `text-slate-*` / `bg-white` / `bg-slate-*` / `border-slate-*` |
|---|---|
| `home-view.tsx` | **152** |
| `save-view.tsx` | 0 |
| `groups-view.tsx` | 0 |
| `invest-view.tsx` | 0 |
| `borrow-view.tsx` | 0 |
| `profile-view.tsx` | 0 |

All six `home-view` sub-screens are `<div className="px-4 pt-5 pb-28">` with no background of their own, so they sit on `.ps`'s `--bg`. `app-shell.tsx:118` renders `data-theme` as `undefined` when `theme === 'system'`, which is the default, so the media-query branch applies and `--bg` becomes `#0D1411` for every user whose phone is in dark mode.

*Consequence:* `text-slate-900` (`#0f172a`) on `#0D1411` is roughly 1.05:1. Headings, body copy and every "Back" control in the entire Send and Receive flow are invisible. Inputs survive because they carry their own `bg-slate-50`, which makes it worse than a uniformly broken screen: the user sees floating form fields with no headings and no visible way back, on the highest-stakes screen in the product.

*This also means the fix is bounded.* One file. The `.ps` vocabulary it needs (`.h2`, `.p`, `.back`, `.field`, `.lab`, `.cta`, `.info`, `.note`, `.flash`) already exists and is complete. Nothing new needs designing, and the duplicated class strings in `UX-34` disappear as a side effect.

### 3.3 — The design system has colour tokens and nothing else.

Measured across `globals.css`:

| Dimension | Distinct values | Notes |
|---|---|---|
| `font-size` | **19** | 9, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 16, 19, 22, 28, 29, 33, 39 |
| `border-radius` | **11** | 5, 6, 9, 11, 12, 13, 15, 16, 18, 22, 999 |
| `font-weight` | 5 | 600, 650, 680, 700, 800 — two of which currently do nothing (3.1) |
| spacing | no scale | ~40 inline px values |
| elevation | 1 | single `--shadow` |
| motion | 0 tokens | 3 inline durations, 1 keyframe |
| `:focus-visible` | **0 rules** | and `.field` sets `outline:none` |

Sizes separated by 0.5px are drift, not intent. This is the difference between a UI that reads as deliberate and one that reads as soft.

### 3.4 — The PWA foundation is already good. Do not rebuild it.

`public/manifest.json` is well-formed: `id`, `scope`, `display_override`, `categories`, and a `maskable` icon are all present. `public/sw.js` is deliberately conservative and correct for a fintech — it never caches `/api`, navigations are network-first, and only a static shell is precached. `offline.html` exists.

*Consequence:* R14 is a short list of gaps (`screenshots`, `shortcuts`, a `theme_color` mismatch, install-prompt UI), not a PWA workstream.

---

## 4. Requirements

### R1 — The typographic foundation actually loads

**Story:** As a user, the app should look like one product from signup onward; as the team, our weight ramp should exist on the device, not just in the stylesheet.

**Findings:** `UX-01` (Critical), `UX-18` (Medium)

**Acceptance criteria**
1. WHEN any element inside `.ps` is inspected in the browser, THEN its computed `font-family` SHALL resolve to the `next/font` generated Inter family, and SHALL NOT fall through to `ui-sans-serif` or any system font.
2. WHEN the font is exposed to CSS, THEN it SHALL be via the `next/font` `variable` option consumed as a custom property, and SHALL NOT rely on the literal string `Inter` matching an `@font-face`.
3. WHEN the auth screen, the app shell, and the join page are compared side by side, THEN all three SHALL render in the same typeface.
4. WHEN `font-weight` values are audited after the fix, THEN every weight in use SHALL be a value the loaded font actually provides, and the set SHALL be reduced to at most four steps.
5. WHEN the global `body { font-weight: 600 }` and `p, span, label { font-weight: 600 }` rules are removed, THEN body text SHALL default to a regular weight, and weight SHALL become an explicit per-component choice.
6. WHEN font loading is configured, THEN it SHALL specify `display: 'swap'` so first paint is never blocked on the font.
8. WHEN the font is resolved at build time, THEN it SHALL NOT depend on reaching a third-party host. A build that cannot fetch the font SHALL fail loudly rather than emit a fallback and exit successfully.
7. IF the type scale in R2 is calibrated before this requirement is verified complete, THEN that calibration SHALL be redone, because it will have been measured against the wrong font.

### R2 — The design system has a complete token scale

**Story:** As anyone building a screen, I need to reach for a token rather than invent a pixel value, so the UI stays coherent as it grows.

**Findings:** `UX-17` (Medium)

**Acceptance criteria**
1. WHEN the token layer is defined, THEN it SHALL provide named scales for type, font-weight, spacing, radius, elevation and motion, in addition to the existing colour tokens.
2. WHEN the type scale is applied, THEN the 19 distinct font sizes SHALL be reduced to at most 8, no step SHALL be a fractional pixel value, and the smallest SHALL be no less than 11px.
3. WHEN the radius scale is applied, THEN the 11 distinct values SHALL be reduced to at most 5.
4. WHEN spacing is applied, THEN it SHALL derive from a single base unit, and inline one-off pixel margins and paddings SHALL be replaced with scale references.
5. WHEN elevation is applied, THEN at least three levels SHALL exist, and each SHALL be defined for both light and dark themes.
6. WHEN motion is applied, THEN duration and easing SHALL be tokens, and every animation and transition in the system SHALL reference them rather than inline values.
7. WHEN the token layer is complete, THEN a written reference SHALL exist stating which token to use for which purpose, so the next screen built does not reintroduce drift.
8. WHEN any screen is rebuilt or ported under this spec, THEN it SHALL consume only tokens, and SHALL NOT introduce new raw pixel values for the six scaled dimensions.

### R3 — Every screen is correct in both light and dark themes

**Story:** As a user with my phone in dark mode, I must be able to read every screen in the app, especially the one where I send money.

**Findings:** `UX-02` (Critical), `UX-04` (Critical), `UX-05` (Critical), `UX-32` (Low), `UX-34` (Low)

**Acceptance criteria**
1. WHEN every screen in the app is viewed in light and in dark theme, THEN all text SHALL meet WCAG AA contrast against its actual rendered background, and no text SHALL be invisible.
2. WHEN `home-view`'s six sub-screens are rebuilt, THEN they SHALL use the existing `.ps` primitives, and the 152 hardcoded light-theme Tailwind classes SHALL be reduced to zero.
3. WHEN the CSS is audited for custom properties, THEN every `var()` reference SHALL resolve to a property defined in the token layer, and the undefined `--card` and `--sub` references at `groups-view.tsx:246-250` SHALL be corrected.
4. WHEN a `className` is used anywhere in the app, THEN a corresponding CSS rule SHALL exist, and the undefined `.turnbar` at `groups-view.tsx:289` SHALL either be defined or the markup rebuilt on an existing primitive.
5. WHEN the theme is switched at runtime between system, light and dark, THEN every screen SHALL update without requiring a reload, and no screen SHALL retain colours from the previous theme.
6. WHEN duplicated Tailwind class strings are found, THEN they SHALL be replaced by the equivalent `.ps` primitive; specifically the `.cta` string repeated 4 times and the `.field` string repeated 5 times in `home-view`.
7. WHEN unused CSS is identified, THEN it SHALL be deleted; `.ps .legacy` has zero references and SHALL be removed.
8. WHEN this requirement is verified, THEN verification SHALL be performed on a real device or emulator in both themes, and SHALL NOT rest on code inspection alone.

### R4 — Keyboard and assistive-technology access is baseline

**Story:** As a user navigating by keyboard or screen reader, I need to know where I am and what each control does; as the business, an app handling BVNs and bank details must be usable by people who need larger text.

**Findings:** `UX-07` (High), `UX-08` (High), `UX-09` (High), `UX-15` (High), `UX-19` (Medium), `UX-25` (Medium)

**Acceptance criteria**
1. WHEN any interactive element receives keyboard focus, THEN a visible focus indicator SHALL be shown meeting WCAG 2.4.7, and no rule SHALL suppress it with `outline: none` without providing a replacement.
2. WHEN any form input is rendered, THEN it SHALL have an `id` and its label SHALL reference it via `htmlFor`, such that tapping the label focuses the input and a screen reader announces the field name. This applies to all 54 existing `<label>` elements.
3. WHEN a control conveys its purpose only by icon, THEN it SHALL have an accessible name. This includes every copy-to-clipboard button, the password visibility toggle, and every sheet close control.
4. WHEN the viewport is configured, THEN it SHALL NOT set `maximumScale` or `userScalable: false`, so pinch-zoom works as required by WCAG 1.4.4.
5. WHEN the active navigation tab is rendered, THEN it SHALL be marked with `aria-current`, and its active state SHALL be conveyed by more than colour alone.
6. WHEN navigation labels are sized, THEN they SHALL be no smaller than the minimum step of the R2 type scale, replacing the current 9px.
7. WHEN a scrollable region contains more content than is visible, THEN some affordance SHALL indicate this; the global `* { scrollbar-width: none }` suppression SHALL be scoped so it does not remove the only such cue on pointer devices.
8. WHEN any status is communicated, THEN it SHALL NOT rely on colour alone. This includes transaction direction and pending state.
9. WHEN the consumer app is audited against WCAG 2.1 AA, THEN every failure SHALL be either fixed or recorded with a written justification. Automated tooling SHALL be used, and SHALL be treated as necessary but not sufficient.

### R5 — Navigation is addressable and survives the back button

**Story:** As a user three screens into a withdrawal, pressing back must take me back one screen, not close the app and lose what I typed.

**Findings:** `UX-03` (Critical), `UX-20` (Medium)

**Acceptance criteria**
1. WHEN a user changes tab or enters a sub-screen, THEN the location SHALL be reflected in the URL.
2. WHEN a user presses the system or browser back button, THEN they SHALL return to the previous screen, and SHALL NOT exit the app unless they are at the root.
3. WHEN a user is partway through a multi-step money flow and navigates back, THEN previously entered values SHALL be preserved for the duration of the session.
4. WHEN a URL for any tab or sub-screen is opened directly, THEN the app SHALL render that destination, subject to auth and gating.
5. WHEN the navigation structure is revised, THEN the number of primary destinations SHALL be reduced from six, the two highest-frequency actions (Send, Receive) SHALL be reachable from the primary navigation rather than only from inside a card, and no existing capability SHALL become unreachable.
6. WHEN a destination is merged with another, THEN the merge SHALL be justified by a shared user mental model, and each merged area SHALL remain individually linkable.
7. WHEN routing is introduced, THEN it SHALL not regress first paint or introduce a full reload on tab change.

### R6 — Feedback is a typed system, not per-component strings

**Story:** As a user, an error that tells me to do something must stay on screen long enough to do it; as the team, message colour must not depend on the words we chose.

**Findings:** `UX-10` (High), `UX-11` (High), `UX-12` (High)

**Acceptance criteria**
1. WHEN feedback is displayed, THEN its kind SHALL be carried as an explicit typed value, and SHALL NOT be inferred by pattern-matching the message text. The three separate regexes in `save-view`, `groups-view` and `invest-view` SHALL be removed.
2. WHEN an error is displayed, THEN it SHALL persist until dismissed or resolved, and SHALL NOT auto-clear on a timer. The 11 `setTimeout(… , 3000|4000)` clears SHALL be re-evaluated individually; success messages MAY auto-dismiss.
3. WHEN an error has a recovery path, THEN the feedback SHALL carry an action affording it, rather than only describing the problem.
4. WHEN a provider or database error occurs, THEN the user SHALL see human copy explaining what happened and what to do, and SHALL NOT see raw error text from Supabase, Postgres or an upstream API. This covers the 8 identified call sites.
5. WHEN error copy is written, THEN the mapping from underlying error to user-facing message SHALL live in one shared place, extending the approach already used well at `auth-screen.tsx:71-83`.
6. WHEN a user action fails validation, THEN the affected field SHALL be identified, and the message SHALL NOT appear only as a detached banner.
7. WHEN a form is submitted with input that cannot succeed, THEN it SHALL be caught before the request; `groups-view.tsx:82` `parseInt(formMax)` SHALL be bounded and validated so an empty or out-of-range member count cannot reach the database.

### R7 — Loading and mutation feel instant

**Story:** As a user on Nigerian mobile data, the app should respond to my tap immediately rather than showing me a spinner while it waits on a server.

**Findings:** `UX-06` (Critical), `UX-21` (Medium), `UX-22` (Medium)

**Acceptance criteria**
1. WHEN a screen is loading, THEN it SHALL render a placeholder in the shape of the eventual content, and SHALL NOT render a bare centred spinner or a blank region.
2. WHEN content arrives, THEN it SHALL replace the placeholder without a layout shift.
3. WHEN a screen has no data because a fetch failed, THEN it SHALL say so and offer a retry, and SHALL NOT render indefinitely empty. `save-view.tsx:55`, which returns `<div className="b" />`, SHALL be corrected.
4. WHEN a data hook swallows an error, THEN that SHALL be reconsidered; `useWallet`'s empty `catch` SHALL surface a state the UI can act on.
5. WHEN a user performs an action with a predictable result, THEN the UI SHALL reflect it immediately and reconcile against the server response, rather than awaiting the response before showing any change.
6. IF an optimistic update is contradicted by the server, THEN the UI SHALL roll back to the true state and explain what happened. No optimistic update SHALL be applied to a value the client cannot predict.
7. WHEN data is refreshed after a mutation, THEN only the affected datasets SHALL be refetched; the current `refresh()` which unconditionally refetches wallet, transactions and profile SHALL be narrowed.
8. WHEN a pending transaction is being polled, THEN the polling interval and payload SHALL be sized with mobile data cost in mind, and polling SHALL remain suspended while the tab is hidden as it is today.
9. WHEN a user pulls down on a scrollable primary screen, THEN the app SHALL refresh.

### R8 — Money movement is confirmed, receipted and traceable

**Story:** As a user sending money to an account number I typed by hand, I want to see exactly who and what before it goes, and to have proof afterwards.

**Findings:** `UX-13` (High), `UX-14` (High), `UX-28` (Medium), `UX-29` (Medium), `UX-30` (Medium)

**Acceptance criteria**
1. WHEN a user submits a transfer, THEN a review step SHALL be presented before execution, showing recipient name, bank, amount, each fee, and the total to be debited.
2. WHEN the review step displays fees or totals, THEN those figures SHALL come from a server-provided quote. The rates hardcoded at `home-view.tsx:770-773` SHALL be removed, and the UI SHALL NOT compute a total the backend has not confirmed.
3. IF a server quote cannot be obtained, THEN the transfer SHALL NOT proceed, and the user SHALL be told why. No fallback estimate SHALL be shown as if authoritative.
4. WHEN a transfer is confirmed, THEN confirmation SHALL require a deliberate act distinct from the form submission itself.
5. WHEN the resolved recipient name is available from name enquiry, THEN it SHALL be given visual prominence on the review step, since it is the primary defence against a mistyped account number.
6. WHEN a transfer completes, THEN a receipt SHALL be presented showing amount, recipient, reference and timestamp, and it SHALL be shareable via the platform share sheet.
7. WHEN a transaction is in progress, THEN its state SHALL be shown as a sequence of stages with timing, and SHALL NOT be represented only by the word "Processing".
8. WHEN a user enters an amount, THEN any applicable tier limit and remaining headroom SHALL be shown inline as they type, and SHALL NOT be revealed only as an error after submission.
9. WHEN a limit blocks an action, THEN the path to raising it SHALL be offered in place, and that message SHALL NOT auto-dismiss.

### R9 — Modals and sheets are real dialogs

**Story:** As a user of assistive technology or a keyboard, a sheet that opens over the app must behave like a dialog.

**Findings:** `UX-16` (High)

**Acceptance criteria**
1. WHEN a modal or sheet is open, THEN it SHALL carry `role="dialog"` and `aria-modal`, focus SHALL move into it, focus SHALL be trapped within it, and focus SHALL return to the invoking control on close.
2. WHEN a modal or sheet is open, THEN Escape SHALL close it, and background scroll SHALL be locked.
3. WHEN a sheet is dismissed by tapping its backdrop, THEN an equivalent keyboard-reachable dismissal SHALL also exist. A bare `div` with `onClick` SHALL NOT be the only affordance.
4. WHEN sheets are implemented, THEN one shared primitive SHALL be used. The four hand-rolled implementations — `StatementSheet`, `TxDetail`, the loan agreement, and the invest sell sheet — SHALL be replaced by it, and `ConfirmProvider` SHALL be folded into or built on the same primitive.
5. WHEN a sheet is presented on a touch device, THEN it SHALL support drag-to-dismiss.
6. WHEN a sheet contains more content than fits, THEN it SHALL scroll internally without scrolling the page behind it.

### R10 — The app is one visual identity end to end

**Story:** As a new user arriving from a friend's invite link, every screen should look like the same company.

**Findings:** `UX-24` (Medium), `UX-37` (Low), `UX-39` (Low)

**Acceptance criteria**
1. WHEN the signup journey is walked from invite link through auth to the app, THEN every screen SHALL share one palette and one typeface. The purple `join/[groupId]` page and the slate auth screen SHALL be brought onto the `.ps` identity.
2. WHEN brand colours are defined, THEN there SHALL be one source of truth. The unused `pawa` palette in `tailwind.config.js` SHALL be removed or reconciled, and the disagreement between `.ps --green` (`#0A6B42`), `viewport.themeColor` (`#059669`) and `brand` (`#10B981`) SHALL be resolved.
3. WHEN the auth screen is rendered, THEN it SHALL NOT enumerate infrastructure vendors to end users; the "Powered by Supabase · FlintAPI · Base L2" line SHALL be removed.
4. WHEN provider names appear in user-facing copy or transaction descriptions, THEN they SHALL be consistent, or absent. The current mix of "FlintAPI", "Flipeet" and "selected automatically" SHALL be reconciled.
5. WHEN `/protocol` and `/admin` retain their own vocabulary, THEN that separation SHALL be documented so it reads as intentional rather than as drift.

### R11 — Numbers are formatted identically everywhere

**Story:** As a user, the same balance should look the same on every screen.

**Findings:** `UX-23` (Medium), `UX-33` (Low)

**Acceptance criteria**
1. WHEN a naira amount is rendered anywhere in the app, THEN it SHALL go through one shared formatter.
2. WHEN that formatter is applied, THEN locale and decimal behaviour SHALL be explicit and identical across screens. The local `naira()` at `borrow-view.tsx:29` and the 11 `toLocaleString(undefined, …)` calls in `invest-view.tsx` SHALL be replaced.
3. WHEN a value requires different precision in a particular context, THEN that SHALL be an argument to the shared formatter, not a separate implementation.
4. WHEN numeric values are displayed, THEN they SHALL use tabular figures so digits do not shift as values update.
5. WHEN dead formatting or rate plumbing is identified, THEN it SHALL be removed. `home-view.tsx:113-122` fetches `/api/ramp/rate` and threads it into `microUsdcToKobo(…, rate)`, whose signature at `format.ts:44` ignores the argument entirely.

### R12 — A new user reaches first value

**Story:** As someone who just signed up, the app should show me what to do next rather than a set of empty containers.

**Findings:** `UX-27` (Medium)

**Acceptance criteria**
1. WHEN a screen has no data for a new user, THEN it SHALL present what the feature does and a single clear action, and SHALL NOT present an empty container.
2. WHEN a user has not completed the actions that make the product useful, THEN progress toward them SHALL be visible on the home screen, and it SHALL disappear once complete.
3. WHEN a user has earned yield, THEN it SHALL be presented as a trend with context, not only as a single figure. The `cngn_yield_earned_micro` line is currently one sentence.
4. WHEN a gating screen is shown (PIN, biometric, KYC), THEN the user SHALL understand why it is required and what happens next, and SHALL NOT be able to reach a state with no forward or backward path.
5. WHEN onboarding requires waiting on an external provider, THEN progress and expected duration SHALL be communicated, and a manual re-check SHALL be available. The existing BVN "Creating your account…" poll is the pattern to follow.

### R13 — Dead code and drift are removed

**Story:** As the next engineer in this codebase, what I read should describe what ships.

**Findings:** `UX-31` (Low), `UX-32` (Low), `UX-26` (Medium)

**Acceptance criteria**
1. WHEN a component has no reachable import path, THEN it SHALL be deleted. `goals-view.tsx` (636 lines), `vault-view.tsx` (469) and `activity-view.tsx` (390) are unreferenced, totalling 1,495 lines.
2. WHEN dead code is deleted, THEN it SHALL first be confirmed superseded rather than pending, and any behaviour in it not present in the live views SHALL be recorded before removal.
3. WHEN a constant is duplicated across live and dead code, THEN the duplication SHALL be removed so future changes have one call site. `vault-view.tsx:26` declares its own `FIXED_APY_MAX`.
4. WHEN unused CSS or configuration is identified, THEN it SHALL be removed.
5. WHEN this requirement is complete, THEN a grep for each removed symbol SHALL return no live references, and the app SHALL build and typecheck clean.

### R14 — Platform integration feels native

**Story:** As a user who installed this to my home screen, it should behave like an app.

**Findings:** `UX-35` (Low), `UX-36` (Low), `UX-40` (Low), `UX-38` (Low)

**Acceptance criteria**
1. WHEN a meaningful interaction occurs, THEN tactile feedback SHALL be provided where the platform supports it, at differentiated intensities for navigation, success and failure.
2. WHEN the app is installable, THEN a contextual install prompt SHALL be offered in-app rather than relying only on the browser's default affordance.
3. WHEN the install prompt is shown by the platform, THEN the manifest SHALL supply `screenshots` so the prompt is rich rather than bare.
4. WHEN a user long-presses the installed icon, THEN shortcuts to the highest-frequency actions SHALL be offered. This depends on R5 routing.
5. WHEN theme colour is declared, THEN `manifest.json` and `viewport.themeColor` SHALL agree; they currently differ (`#0A6B42` vs `#059669`).
6. WHEN the app requests third-party assets, THEN it SHALL NOT leak user behaviour. `stock-chart.tsx:133` requests logos from Clearbit per symbol viewed, revealing which equities each user browses; these SHALL be self-hosted or proxied.
7. WHEN the service worker is touched, THEN its existing conservative posture SHALL be preserved. It SHALL continue to never cache `/api` or authenticated responses.

### R15 — Surfaces are solid and the palette is near-monochromatic

**Story:** As a user, the app should look composed and deliberate rather than decorated; as the team, our accent colour should mean something because it is used sparingly.

**Findings:** `UX-41` (Medium), `UX-42` (Medium), `UX-45` (Low)

**Acceptance criteria**
1. WHEN any surface is rendered, THEN it SHALL use a solid fill, and no `linear-gradient` SHALL remain in the consumer app's chrome.
2. WHEN a surface previously used a gradient, THEN it SHALL be replaced by a single solid token, and the pair `--card-a` / `--card-b` SHALL be collapsed accordingly.
3. WHEN decorative elements exist purely for gloss, THEN they SHALL be removed. This includes the translucent radial overlay at `globals.css:112` (`.ps .acct::after`).
4. WHEN the palette is defined, THEN neutrals SHALL be the dominant surface family, and the accent hue SHALL NOT be used as the fill of the largest surface on a screen.
5. WHEN the accent hue is used, THEN it SHALL carry a single consistent meaning — positive movement and primary action — and SHALL NOT be used decoratively.
6. WHEN a colour conveys state, THEN the set of state colours SHALL be limited to the accent, one negative and one warning, and each SHALL be used only for state, never for ornament.
7. WHEN content sits on a dark solid surface, THEN its foreground colours SHALL be defined tokens. Ad-hoc `rgba(255,255,255,α)` values, which currently work only because a gradient sits behind them, SHALL be replaced.
8. WHEN the hero surface is rendered in dark theme, THEN it SHALL be distinguished from the page background by elevation and border rather than by hue, since a near-black card on a near-black background would otherwise disappear.
9. WHEN the palette change is verified, THEN contrast SHALL be re-measured on every affected surface in both themes, because changing a gradient to a solid changes the effective background of every element on it.
10. IF the brand logo's internal gradient (`logo.tsx:13`) is to be flattened, THEN that SHALL be an explicit brand decision recorded here, not an incidental consequence of this requirement.

### R16 — One icon system, used with intent

**Story:** As a user, icons should help me identify things quickly and should not be wrong; as the team, we should have one icon system rather than two.

**Findings:** `UX-43` (Medium), `UX-44` (Medium), `UX-46` (Low)

**Acceptance criteria**
1. WHEN an icon is rendered anywhere in the consumer app, THEN it SHALL come from one icon library. The current split of 39 distinct `lucide-react` icons plus 27 hand-rolled inline SVGs across 8 files SHALL be resolved to a single source.
2. WHEN the icon library is selected, THEN it SHALL provide a weight or fill axis, so that state can be conveyed by icon treatment rather than by colour alone.
3. WHEN a navigation item is active, THEN its icon SHALL change weight or fill, satisfying the non-colour active-state requirement in R4.5 through the icon system rather than as a separate mechanism.
4. WHEN an icon metaphor is chosen for navigation or a primary action, THEN it SHALL favour recognisability over novelty. Conventional metaphors are correct where identification speed matters.
5. WHEN an icon metaphor is factually wrong for the market, THEN it SHALL be replaced. The `NavBorrow` glyph at `app-shell.tsx:22` draws a dollar sign and sits in the primary navigation of a naira product.
6. WHEN icon sizes are used, THEN they SHALL come from a defined scale rather than the current ad-hoc mix of 16, 17, 20 and 24px.
7. WHEN default icon size and weight are set, THEN they SHALL be configured centrally rather than repeated at each call site.
8. WHEN an empty state requires illustration (R12.1), THEN it SHALL be satisfied using the icon system's expressive weight at large size, rather than by introducing a separate illustration dependency.
9. WHEN the icon migration is complete, THEN no inline hand-rolled `<svg viewBox>` icon SHALL remain in the consumer app, and bundle size SHALL be measured before and after to confirm tree-shaking is effective.
10. WHEN icons carry more of the interface's meaning because the palette is near-monochromatic (R15), THEN icon clarity at the smallest used size SHALL be verified on a real device, not only in the browser.

### R17 — A user can stop anything they can start

**Story:** As someone who turned on automatic contributions, I need to be able to turn them off.

**Findings:** `UX-48` (High)

Found while doing R13.2's "confirm superseded, not pending" check before deleting dead code. It is not a styling issue, but it was surfaced by this spec and should not be dropped on the floor.

**What is certain:**
- `save-view.tsx:105` creates a goal with a `frequency` of daily, weekly or monthly, and `api/cron/auto-contribute/route.ts` runs against it on a schedule.
- `savings_goals.auto_contribute_enabled` exists, and `set_goal_auto_contribute` (`use-data.ts:532`) is the only way to change it.
- The only caller was `goals-view.tsx:147`, which has no reachable import path. **So there is no way to pause recurring debits in the shipped app.**

**What is not yet known:** whether the column defaults to enabled, and what `auto_contribute_goals` actually gates on. That RPC has no definition in the repository — it falls in the missing 046–061 migration range noted by the `week1-critical-remediation` spec. Severity depends on it.

**Acceptance criteria**
1. WHEN the column default for `auto_contribute_enabled` and the body of `auto_contribute_goals` are read from production, THEN it SHALL be recorded whether goals are auto-debited without the user opting in. This SHALL happen before the UI is designed, because it decides whether this is a defect or a missing convenience.
2. IF auto-contribution is active by default, THEN this SHALL be treated as a live defect affecting money movement and escalated out of this spec into the remediation track.
3. WHEN a savings goal has auto-contribution active, THEN the user SHALL be able to see that it is active and pause it, from the live UI.
4. WHEN the user pauses or resumes it, THEN they SHALL get explicit confirmation of the new state.
5. WHEN any future feature starts a recurring debit, THEN the same screen SHALL offer the means to stop it. No recurring money movement SHALL be startable from a screen that cannot also stop it.

---

## 5. Finding index

Severity reflects user impact, not implementation cost.

| ID | Severity | Finding | Req |
|---|---|---|---|
| `UX-01` | Critical | Inter never loads inside `.ps`; app renders in system font, weight ramp collapses | R1 |
| `UX-02` | Critical | Send/Receive flow unreadable in dark mode (152 hardcoded classes) | R3 |
| `UX-03` | Critical | System back exits app mid-flow; tab and sub-view state are local | R5 |
| `UX-04` | Critical | Ajo invite code invisible in light mode; `--card`/`--sub` undefined | R3 |
| `UX-05` | Critical | `.turnbar` has no CSS; manager banner renders as an unstyled full-width SVG | R3 |
| `UX-06` | Critical | Save view renders an indefinitely blank screen while loading | R7 |
| `UX-07` | High | Zero `:focus-visible` rules; `.field` sets `outline:none` | R4 |
| `UX-08` | High | 54 labels, 0 `htmlFor`; no label-input association anywhere | R4 |
| `UX-09` | High | Pinch-zoom disabled | R4 |
| `UX-10` | High | Errors auto-dismiss after 3–4s, including actionable instructions | R6 |
| `UX-11` | High | Status colour inferred by regex-matching message copy | R6 |
| `UX-12` | High | Raw Postgres/Supabase errors shown to users at 8 call sites | R6 |
| `UX-13` | High | Withdrawal fees hardcoded in the component; can disagree with server | R8 |
| `UX-14` | High | No review step before an irreversible transfer | R8 |
| `UX-15` | High | One `aria-label` in the codebase, and it is in `/protocol` | R4 |
| `UX-16` | High | Four hand-rolled sheets are not dialogs | R9 |
| `UX-17` | Medium | No scale layer: 19 font sizes, 11 radii, no spacing/motion/elevation tokens | R2 |
| `UX-18` | Medium | Global weight overrides flatten hierarchy; no regular weight available | R1 |
| `UX-19` | Medium | Nav labels 9px; no `aria-current`; colour-only active state | R4 |
| `UX-20` | Medium | Six-tab IA; Borrow in prime real estate, Send/Receive buried in a card | R5 |
| `UX-21` | Medium | No skeletons; spinner-to-content layout jump on every load | R7 |
| `UX-22` | Medium | No optimistic UI; `refresh()` refetches three datasets per mutation and per poll | R7 |
| `UX-23` | Medium | Three disagreeing currency formatters | R11 |
| `UX-24` | Medium | Four visual identities across the funnel | R10 |
| `UX-25` | Medium | Global scrollbar suppression removes the only scroll affordance | R4 |
| `UX-26` | Medium | Unvalidated `max_members` in circle creation reaches the database | R6 |
| `UX-27` | Medium | No empty-state onboarding or activation surface | R12 |
| `UX-28` | Medium | No receipt or share affordance after a transfer | R8 |
| `UX-29` | Medium | "Processing" with no status timeline | R8 |
| `UX-30` | Medium | Tier limits surface as a post-submit error, not inline headroom | R8 |
| `UX-31` | Low | 1,495 lines of dead UI across three unreferenced views | R13 |
| `UX-32` | Low | `.ps .legacy` is dead CSS | R3, R13 |
| `UX-33` | Low | Dead rate plumbing in `home-view` | R11 |
| `UX-34` | Low | `.cta` and `.field` class strings duplicated 4 and 5 times | R3 |
| `UX-35` | Low | `manifest.json` `theme_color` disagrees with `viewport.themeColor` | R14 |
| `UX-36` | Low | No manifest `screenshots` or `shortcuts`; no in-app install prompt | R14 |
| `UX-37` | Low | Vendor stack enumerated in the auth footer | R10 |
| `UX-38` | Low | Clearbit logo requests reveal which equities a user views | R14 |
| `UX-39` | Low | Two component vocabularies (`.proto-*` vs `.ps`) undocumented | R10 |
| `UX-40` | Low | No haptic feedback | R14 |
| `UX-41` | Medium | Gradient-filled hero surfaces plus a decorative gloss overlay | R15 |
| `UX-42` | Medium | Accent hue fills the largest surface, so it reads as decoration not signal | R15 |
| `UX-43` | Medium | Two icon systems: 39 lucide icons plus 27 hand-rolled inline SVGs | R16 |
| `UX-44` | Medium | `NavBorrow` draws a dollar sign in the primary nav of a naira product | R16 |
| `UX-45` | Low | Foreground chrome uses `rgba(255,255,255,α)` that only works over a gradient | R15 |
| `UX-46` | Low | Icon sizes are ad-hoc (16/17/20/24px) with no scale or central default | R16 |
| `UX-47` | **High** | `next/font/google` fetches at build time and silently ships a fallback font on network failure, exiting 0 | R1 |
| `UX-48` | **High** | Recurring auto-contributions can be switched on but not off: the only UI that called `set_goal_auto_contribute` was the unreachable `goals-view` | R17 |

## 6. Verification posture

Two rules, both learned from the Week 1 spec.

**Device verification, not inspection.** `UX-02`, `UX-04` and `UX-05` were all found by reading the CSS cascade, and none of them has been observed on a real screen. Every contrast and theme criterion in R3 must be signed off on a device or emulator in both themes. Code inspection found these bugs; it is not sufficient to confirm they are fixed.

**Confirm the diagnosis before building on it.** R1 is the load-bearing assumption of this entire spec. Before any type-scale work begins, open devtools, select an element inside `.ps`, and read the computed `font-family`. The build-output evidence in 3.1 is strong but it is static analysis. Five seconds of runtime confirmation gates a week of downstream work.
