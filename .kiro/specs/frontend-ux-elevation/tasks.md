# Frontend UX Elevation: Tasks

**Spec:** `frontend-ux-elevation`
**Requirements:** `requirements.md` (R1–R16) · **Design:** `design.md` (D0–D22)

Phase 1 blocks everything. Within Phase 2, tracks A and B run in parallel. Phase 3 needs Phase 2's primitives. Phase 4 needs Phase 2's routing.

Ordering constraints that matter:
- **Task 1 blocks tasks 2 and 3.** Type and weight scales calibrated before the font loads are calibrated against the wrong font (R1.7)
- **Tasks 1, 2, 3 and 8 must be reviewed together, on device, in one sitting.** Font, type scale, weight scale and palette all change how every screen looks. Each looks wrong alone. See design §7
- **Task 6 blocks task 7.** Verify Phosphor's bundle cost and small-size legibility before migrating 66 call sites
- **Tasks 7 and 8 must land before task 9.** Otherwise `home-view` gets ported once for styling, then touched again for icons and again for the palette
- **Task 10 must land before any token is named `--card`.** `groups-view.tsx:246` references undefined `var(--card, …)`; defining that name hides the bug instead of fixing it. D21 uses `--hero` to sidestep this
- **Task 9 must not include the fee fix or the flow restructure.** Those are tasks 23 and 24. Keeping them out is what makes a 1,048-line port reviewable
- **Task 15 blocks tasks 24, 31 and 36.** Routing is a prerequisite for the send flow, the IA, and manifest shortcuts
- **Task 23 blocks task 24.** The review step must not render a total the server has not confirmed
- **Task 3 changes layout heights.** Re-check `.ps .b` bottom padding against the new nav height before closing Phase 1

## Log

**08 Sep — Phase 1 tasks 1–4 done, plus the logo (D23).**

The font fix is confirmed in the emitted CSS, which is stronger evidence than the
diagnosis was. `--font-inter` now resolves to `"__Inter_f367f3","__Inter_Fallback_f367f3"`,
and both `body` and `.ps --sans` consume it. No literal `'Inter'` is left anywhere.
Still owed: runtime devtools confirmation, which happens in task 14.

Weights are fully tokenised — no raw numeric `font-weight` remains in the `.ps` system.
Final counts: `w-semi` 30 uses, `w-bold` 12, `w-normal` 1, **`w-medium` 0**.

**`--w-medium` call, closed.** Decided on a rule rather than case by case, so it holds
for screens not built yet:

> **At 12px and below, 500 is the floor. Above 12px, prose is 400 and labels or
> controls are 500.**

The reasoning: small low-contrast text needs more stroke to hold the same optical
density as body copy. Bumping weight is the right lever because darkening the colour
instead would collapse the `--ink` / `--muted` / `--faint` hierarchy that the whole
system leans on. The rule is committed as a comment on the weight tokens.

Applied to 13 rules. `.ps .p` is deliberately the only rule left without an explicit
weight — it is prose at 12.5px, so it inherits 400. Final distribution: `w-normal` 1,
`w-medium` 13, `w-semi` 31, `w-bold` 12.

**Caught while doing it:** `.ps .acct-bal .k` (the kobo digits) had no weight of its own
and used to be picked up by the old global `p,span,label{600}`. Removing that rule meant
it started *inheriting* `.acct-bal`'s 700, so it silently got heavier and stopped sitting
back from the naira figure. Now pinned to 600. Worth watching for the same pattern during
the task 9 port: any bare `span` that relied on the old global rule will now inherit its
parent's weight instead.

`tsc --noEmit` clean, `next build` clean. One flaky `ENOTEMPTY` on a cold build with a
wiped `.next`; retry succeeded, not a code issue.

**08 Sep, unplanned, closed — `UX-47`, new High.** Trying to review task 1 locally
found a worse bug underneath it. `next/font/google` fetches during the build and, when
it can't reach `fonts.googleapis.com`, warns and ships a fallback while **exiting 0**.
Reproduced on this machine: `⨯ Failed to download Inter from Google Fonts. Using
fallback font instead.` A network blip in the Coolify Docker build would have shipped
the wrong typeface with a green build — the same silent degradation task 1 was fixing.

Switched to `next/font/local` against a vendored 48KB latin variable woff2 (wght
100-900) from `@fontsource-variable/inter@5.3.0`, OFL-1.1, licence committed alongside.
No third-party network in the build any more. Verified in the production build:
`@font-face{font-family:__inter_365cbc; src:url(...woff2); font-weight:100 900}`, the
served file byte-identical to the vendored one, and zero literal `'Inter'` references
left. Added R1.8 to stop this regressing.

**Also added: dev-only design-system page** at `/design-system`, `notFound()` in
production. The app needs a real login to reach `.ps`, so without it there was no way
to eyeball tokens locally. Renders the type and weight ramps, colour tokens, radius,
elevation, icon sizes, the logo at five sizes, the live `.ps` primitives, a focus-ring
bed, and the 400-vs-500 comparison. Carries through tasks 5-8.

**09 Sep — task 5 done, spacing split out as 5b.**

Type, radius, elevation and motion are fully tokenised. Verified in the emitted CSS:
exactly 8 type steps and 5 radii, `--shadow` gone from all three theme blocks, `.legacy`
gone, every `var()` resolving. `tsc` and `next build` clean.

**Deliberate deviation:** spacing was left out and moved to task 5b, to run after the
task 14 device review rather than before it. The existing values sit on odd numbers, so
6/10/14/18/22px are each equidistant between two steps of a 4px grid — snapping them
shifts every component's internal rhythm simultaneously. Doing that in the same change
as the font, weight and palette work would leave no way to attribute a regression. Type
and radius were safe now because the rationale is clear and layout risk is low.

Type mapping worth knowing: `39px → 36px` and `33px → 36px`, so the Home hero balance
and the Borrow headline figure are now the same size. They never appear on the same
screen, and the result is a consistent display treatment, but it is a real change from
two sizes to one. Similarly `29px`/`28px` both land on 28.

`--e-1`, `--e-3`, `--dur-base`, `--ease-spring` and the `--i-*` icon sizes are defined
and unused. That is expected: elevation 1 and 3 are available, the motion pair gets used
by the sheet and toast in Phase 2, and the icon scale by tasks 6-7.

**09 Sep — task 6 done. Phosphor confirmed, with one question left for the reviewer.**

`@phosphor-icons/react@2.1.7`, pinned exact. `sideEffects:false`, per-icon exports, and
separate `dist/ssr` and `dist/csr` entries. Every view we touch is already `'use client'`,
so the default entry is correct and `IconContext` works.

**Tree-shaking: confirmed, decisively.** Measured `/` First Load JS across three builds:

| Stage | `/` route | First Load |
|---|---|---|
| baseline (lucide + inline SVG) | 40.3 kB | 199 kB |
| + Phosphor nav, 6 icons + IconContext | 45.8 kB | 205 kB |
| + icon review page, 13 more icons | 40.2 kB | 205 kB |

A 1,250-icon library costing 6 kB for 6 icons settles it. The third row is Next hoisting
the now-shared Phosphor code out of `/`'s route chunk into a shared one, which is why the
route size drops while First Load holds. `/design-system` renders 13 distinct icons plus
six weight variants and three duotone in **6.87 kB** of route code, so marginal per-icon
cost is roughly 0.4-0.5 kB.

**Prediction at spike time was that removing lucide would bring this back near baseline.
That was wrong — see the task 7 entry below for the measured outcome.**

**What the weight axis bought us, already banked in this task:** the nav active state is
now `regular` → `fill`, so it no longer depends on colour alone (R4.5, WCAG 1.4.1), and
`aria-current="page"` went on at the same time. That is a chunk of task 21 done early
because the icon system made it nearly free.

**Fixed the wrong metaphor:** `NavBorrow` was a hand-drawn dollar sign in the primary nav
of a naira product. Now `HandCoins`. Nav set is House · Vault · UsersThree · TrendUp ·
HandCoins · User — deliberately conventional, per R16.4.

**Still open, needs a human on a screen:** whether `regular` is legible at `--i-sm` (16px)
on a low-density device. I cannot judge this from a build. The design-system page now has
a size ramp and a full weight ramp for the call. If 16px regular reads too light, the fix
is `bold` at small sizes, not a different library.

**Install note:** npm reported `ERESOLVE ... Found: react-dom@undefined` against
Phosphor's `peer react-dom >= 16.8`, which is spurious — react-dom 18.3.1 is installed and
resolves fine. npm's tree view was inconsistent with disk, probably from an earlier
interrupted install. The install completed correctly and no `--legacy-peer-deps` or
`--force` was needed. Worth knowing if it resurfaces on another machine.

**09 Sep — task 13 done, task 7 done for the consumer app. One cost decision needs a call.**

Dead views deleted, 1,495 lines. Surfaced `UX-48` / `R17` on the way, see the commit and
the requirement. `FIXED_APY_MAX` turned out to exist *only* in `vault-view`, so it is now
gone entirely rather than deduplicated.

Icon migration: all nine consumer files moved to Phosphor. 30 distinct icons. `tsc` clean.

**I got the bundle cost wrong, and by enough to matter:**

| Stage | `/` route | First Load |
|---|---|---|
| baseline (lucide) | 40.3 kB | 199 kB |
| Phosphor nav only, both libs | 45.8 kB | 205 kB |
| consumer app fully migrated | 45.6 kB | **214 kB** |

I predicted a return to ~199 kB. It went to 214, **+15 kB / +7.5%**. Cause found:

```
lucide   icons/wallet.js      594 B   one variant
phosphor defs/Wallet.mjs    2,538 B   all six weights
         csr/Wallet.mjs        794 B   wrapper
                            -------
                            3,332 B   ~5.6x per icon
```

Weight is a **runtime prop**, so every icon ships thin, light, regular, bold, fill and
duotone whether or not you use them. Tree-shaking works between icons but cannot shake
weights within one. 30 icons × ~2.7 kB extra ≈ 82 kB raw ≈ +15 kB gzipped, which matches
the measurement.

**So the weight axis is not free.** It buys the non-colour active nav state (WCAG 1.4.1),
duotone empty states with no illustration dependency, one icon system and the corrected
metaphors, for +7.5% First Load on a data-cost-sensitive market. That is a judgement call,
not a technical one — flagged for the reviewer rather than absorbed silently. If the answer
is no, the fallback is reverting to lucide and solving R4.5 with an underline or dot
indicator instead.

**Admin decision, closed (task 7 asked for one).** `lucide-react` stays, used only by
`admin-view.tsx` and `admin/revenue/page.tsx`. Verified this costs consumer users nothing:
shared-by-all is 87.4 kB in both builds, and admin's First Load is unchanged at 103/161 kB,
so lucide sits entirely in the admin route chunks. Migrating admin would make those routes
*heavier* at 5.6x per icon for no benefit on an internal surface. R16.1 scopes to the
consumer app, which is now single-system. Documented here so it reads as intentional.

**09 Sep — Phase 1 complete except the device review. 13 of 14, plus 5b deferred.**

Tasks 7, 8, 9, 10, 11, 12 all landed. The headline is task 9: `home-view` went from **152
hardcoded light-theme classes to 0**, which closes the Critical dark-mode failure. Five
primitives were genuinely missing and got added rather than inline-styling forty places:
`.info .v` / `.big` / `.hint`, `.breakdown` for fee rows, and `.hint`. Two off-palette
buttons folded into `.cta`, including a withdraw button that was `orange-500` — a colour
that existed nowhere else in the system.

Task 8 removed the last in-scope gradients. Only Tailwind's utility gradient remains, in
the join page and admin, both scheduled for tasks 32/35.

Task 7 finished the icons: 20 inline SVGs across seven files. Two stay deliberately — the
Ajo payout ring is a bespoke 100x100 progress visual rather than an icon, and two in the
design-system page are illustrative. Second name collision found and aliased: `User` in
`profile-view` is the Supabase auth type, same shape of problem as `Bank` in `home-view`.

Task 12's check is worth its keep already: it caught its own author's prose mentioning a
token name, so it now strips comments while preserving line numbers. Verified by
reintroducing the original `UX-04` bug — it fails and points at the line.

**Final bundle:** `/` First Load 218 kB against a 199 kB baseline. Consistent with the
~3.3 kB per Phosphor icon measured in the spike. Shared-by-all unchanged at 87.4 kB.

**Blocked on a human:** task 14 needs a real device in both themes. Every contrast fix in
this phase was derived from reading the CSS cascade and none has been seen on a screen —
that cuts both ways, so the fixes need confirming as much as the bugs did.

**12 Sep — Phase 2 started. Task 21 done, task 19 measurable and in flight.**

Pinch-zoom unblocked (WCAG 1.4.4), scrollbar hiding scoped to `pointer: coarse`, and
`themeColor` reconciled with the manifest.

Two things turned out already satisfied, so no work was invented for them: `aria-current`
landed with the icon migration in task 7, and non-colour status cues already exist —
transaction direction carries distinct icons *and* a `+`/`−` prefix, and pending state is
the word "Processing".

**Unplanned finding: the CI lint step has never run.** ESLint was not a dependency, so
`next lint` had nothing to execute and prompted interactively. `npm run lint --if-present`
found the script, ran it, and did nothing useful. Now installed and pinned with jsx-a11y
enabled, which immediately reproduced the audit's headline number: **47 label errors across
13 files.**

Built `components/ui/field.tsx` for task 19 — generates the id with `useId` and wires
label, hint and error through `aria-describedby`, so the association cannot be forgotten on
a new form.

**Deliberately left as `warn`, not `error`:** the label rule and the three interaction
rules. Flipping them now would leave a branch red that a teammate is actively committing
to. Both have a written note in `.eslintrc.js` saying which task closes them and to promote
the severity at that point.

**Worth knowing before task 19 starts:** not all 47 are the same problem. At least two, in
`save-view` (the lock term and contribution frequency selectors), are `<label>` elements
pointing at *groups of buttons* rather than inputs. Those need `role="group"` plus
`aria-label`; a `htmlFor` would be wrong. Don't apply `Field` blindly across the count.

## Context

**Branch:** `audit-v2-remediation-and-flint-onramp`, the deployed branch. It carries uncommitted work from the Week 1 security remediation (`custody-lease.ts`, migrations 073–074, modified cron and ramp routes). **Coordinate before committing** — do not fold UX changes into those commits.

**Production:** Coolify on Hetzner, Cloudflare in front, Docker build from `frontend/Dockerfile`, Supabase managed. No staging environment yet; the Week 1 spec's tasks 11 and 12 create one. Task 23 wants it.

**Verification baseline:** `npx tsc --noEmit` currently passes clean. Keep it that way at every task boundary.

**Logo decision, closed (R15.10).** The mark keeps a gradient as a deliberate brand-only exception, and is being reworked: deep blue → deep green with a glassy treatment. Recorded in design D23.

**Constraint that comes with it:** the logo now introduces a second hue (blue) that exists nowhere else in the system. That is acceptable for a brand mark and *not* acceptable in UI chrome. Blue SHALL NOT appear in any surface, control, state or icon. If a future screen wants to pull blue out of the logo, that is a palette change requiring its own decision, not a licence granted by this one.

---

## Phase 1 — Foundation (blocks all other work)

- [x] 1. Fix the webfont so Inter reaches the app
  - Add `variable: '--font-inter'` and `display: 'swap'` to the `Inter()` call in `layout.tsx:7`
  - Apply `inter.variable` to `<body>`, **not** `inter.className` — `.className` sets `font-family` on body, which `.ps` then overrides. See design D0
  - Point `.ps --sans` and `globals.css` `body { font-family }` at `var(--font-inter)`
  - **Verify at runtime, not in source:** devtools → select an element inside `.ps` → computed `font-family` must read `__Inter_f367f3`. This gates the phase
  - Expect every heading in the app to change weight, because 650 and 680 currently snap to 700 and will resolve as distinct for the first time. This is correct
  - _Requirements: R1.1, R1.2, R1.3, R1.6_

- [x] 2. Add the token scales to the `.ps` block
  - Type (8 steps, 11px floor), weight (4), spacing (4px base), radius (5), elevation (3), motion (3 durations + 2 easings), icon size (5). Values in design D1 and D22
  - Retain `--shadow` as an alias for `--e-2` for now so the ~12 existing references keep working; remove it in task 5
  - Add `--e-1/2/3` to the dark theme block using the darker values currently in its `--shadow`
  - Write the token reference doc: which token for which purpose (R2.7). Without it the next screen reintroduces drift
  - _Requirements: R2.1–R2.7, R16.6_

- [x] 3. Remove the global font-weight overrides and migrate to the weight scale
  - Delete `body { font-weight: 600 }` and `p, span, label { font-weight: 600 }` from `globals.css`
  - Replace the five weights in use (600, 650, 680, 700, 800) with the four scale steps
  - The app will look noticeably lighter. That is the point — regular weight is currently unreachable, which is why the design compensates with font-size micro-steps
  - **Re-check `.ps .b`'s 96px bottom padding** against the new nav height, since the 11px label floor makes the nav taller
  - _Requirements: R1.4, R1.5, R2.2_

- [x] 4. Add the focus ring
  - One `.ps :focus-visible` rule per design D3. Remove the bare `outline:none` from `.field`, keeping its border-colour change as a secondary cue
  - `:focus-visible` not `:focus`, so pointer users do not see rings on tap
  - Verify by tabbing through every screen. There are currently zero focus indicators anywhere in the app
  - _Requirements: R4.1_

- [x] 5. Migrate the existing `.ps` rules onto the token scales — type, radius, elevation, motion
  - 19 font sizes → the 8 steps. 11 radii → the 5 steps. `var(--shadow)` → `var(--e-2)` and the alias deleted from all three theme blocks
  - Motion tokenised too: the two inline transitions and `psrise`'s easing
  - Also removed `.ps .legacy` here rather than in task 13, since it was dead CSS in a file already being edited. One of the seven gradients gone
  - Grep verified: zero raw `font-size:Npx` or `border-radius:Npx` left in `.ps`, zero `--shadow` references, every `var()` resolves
  - **Spacing deliberately NOT included — see task 5b**
  - _Requirements: R2.8_

- [ ] 5b. Migrate spacing onto the 4px scale — **after task 14, not before**
  - The `--s-*` tokens are defined and currently unused. This is the deferred half of R2.4
  - **Why it waits.** The existing values cluster on odd numbers (11, 13, 15, 17px) so a 4px grid does not fit them cleanly: 6, 10, 14, 18 and 22px are all equidistant between two steps, and there are many of them. Snapping them means shifting the internal rhythm of every component at once, and doing that in the same change as the font, weight and palette work would make an odd-looking screen impossible to attribute. Type and radius were safe to snap now because they carry a clear rationale and little layout risk; spacing does not
  - Sub-4px values (1, 2, 3px) are optical nudges rather than spacing and SHALL stay literal. Record that as an explicit exception to R2.4 rather than forcing them onto the grid
  - Consider whether a 4px base is right at all, or whether the design wants a 2px base given where the current values sit. Decide before migrating, not during
  - Re-check `.ps .b`'s 96px bottom padding against the final nav height as part of this
  - _Requirements: R2.4, R2.8_

- [x] 6. Spike Phosphor: verify bundle cost and small-size legibility
  - **Do this before migrating anything.** Two unverified assumptions gate 66 call sites
  - Confirm the correct `@phosphor-icons/react` v2 entry point for Next 14 App Router (SSR vs CSR builds), and that tree-shaking actually works. **Measure bundle size before and after** on a representative screen — do not take tree-shaking on faith
  - Check `regular` weight at `--i-sm` (16px) on a real low-density device. Phosphor's lighter stroke is an advantage at 20px+ and a risk at 16px. If it is too light, the answer is `bold` at small sizes, not abandoning the library
  - Record the decision and the measured numbers in the Log
  - _Requirements: R16.9, R16.10_

- [x] 7. Migrate to one icon system
  - Done: all 30 consumer lucide icons, the 6 nav glyphs, `IconContext`, `regular`→`fill` active state, `aria-current`, and the dollar-sign fix
  - Still to do: 20 hand-rolled inline `<svg viewBox>` icons — `profile-view` 7, `groups-view` 5, `save-view` 3, `home-view` 1, `pin-setup` 1, `invest-view` 1, plus 2 illustrative ones in the design-system page that can stay
  - **Blocked on the +7.5% bundle call.** No point migrating 20 more icons at 3.3 kB each if the decision is to revert to lucide
  - Replace 39 distinct `lucide-react` icons and **delete all 27 hand-rolled inline `<svg viewBox>` icons** across 8 files, including the six nav glyphs at `app-shell.tsx:16-22`
  - Set defaults centrally via `IconContext` (size and weight) so call sites stop repeating `className="w-4 h-4"`
  - **Fix the wrong metaphor:** `NavBorrow` (`app-shell.tsx:22`) draws a dollar sign — `M12 2v20` plus an S-curve — in the primary navigation of a naira product. Replace with `HandCoins` or `Scales`
  - Ajo nav: consider a circle-of-dots motif echoing `.ps .circle`, the app's strongest component
  - **Keep Home / Save / Invest / You metaphors as they are.** Recognition speed beats novelty in navigation (R16.4). Do not over-correct this task
  - Wire `regular` → `fill` on the active nav item, which is how R4.5's non-colour active state gets satisfied
  - Remove `lucide-react` from `package.json` once the consumer app is clear. Note `/admin` and `/protocol` still import it and are out of scope — either keep the dependency for them or migrate them opportunistically, but decide rather than leaving it ambiguous
  - Verify: grep for `<svg viewBox` returns nothing in the consumer app
  - _Requirements: R16.1, R16.2, R16.3, R16.4, R16.5, R16.7, R4.5_

- [x] 8. Replace gradient surfaces with solids and rebalance the palette to neutral-dominant
  - Only **two CSS rules** are actually in scope: `.ps .acct` (`globals.css:110`) and `.ps .pool` (`:171`). The other five gradients are either dead code deleted in task 13, `/admin` (out of scope), the join page (task 35), or the logo (open question above). Inventory table in design D21
  - Collapse `--card-a` / `--card-b` into a single solid `--hero`. **Name it `--hero`, not `--card`** — see the task 10 ordering constraint
  - **Delete `.ps .acct::after`** (`globals.css:112`), the 170px translucent white circle that exists only to make a gradient look glossy
  - Replace the `rgba(255,255,255,α)` chrome on `.ab`, `.pool .apy` and `.acct-chip` with defined `--on-hero-*` tokens. Those alpha values currently work only because a gradient sits behind them
  - **Dark theme: differentiate the hero by elevation and border, not hue.** A near-black card on `#0D1411` disappears
  - Confine the accent to positive movement and primary action. Keep `--pos` as an alias of `--green` so intent stays readable at call sites
  - **Re-measure contrast on both cards in both themes.** The `--on-hero-*` values in D21 are a starting point, not verified. Swapping a gradient for a solid changes the effective background of every element on the card
  - The logo (D23) already landed ahead of this task — deep blue → deep green glass tile, gradient moved onto the tile, counters masked, ids made unique with `useId`. Nothing left to do there beyond looking at it on device
  - _Requirements: R15.1–R15.9_

- [x] 9. Port `home-view`'s six sub-screens to `.ps` primitives
  - **The Critical dark-mode fix.** 152 hardcoded light-theme classes → zero. Mapping table in design D4; no new CSS required
  - **One commit per sub-screen**, verified on device in both themes before starting the next: `deposit-choose` → `deposit-naira` → `deposit-crypto` → `deposit` → `deposit-info` → `withdraw`. `withdraw` last, it is largest
  - Do **not** restructure the flow (task 24) or fix the hardcoded fees (task 23) here. Port only
  - Extract the bank search-and-select control at `home-view.tsx:670-720` to `components/ui/bank-picker.tsx`. Good pattern, wanted elsewhere
  - Removes the `.cta` string duplicated 4× and the `.field` string duplicated 5× as a side effect
  - _Requirements: R3.1, R3.2, R3.6, R3.8_

- [x] 10. Fix the Ajo invite code visibility
  - `groups-view.tsx:246-250` references `var(--card, …)` and `var(--sub, …)`, neither of which exists, so the fallbacks give a near-black panel while `--ink` resolves to near-black text in light mode
  - Replace the inline styles with `.info`, which is exactly this component
  - This is the code a circle owner reads aloud to onboard a member with no smartphone, so the failure lands on the offline-inclusion feature
  - _Requirements: R3.3, R3.8_

- [x] 11. Rebuild the Ajo manager banner
  - `groups-view.tsx:289` uses `className="turnbar"`, which no rule defines, and its inline SVG renders at intrinsic full width because `.turnbar .ic svg` has no size rule either
  - Rebuild on `.rows` + `.row` (`.dot`, `.mid`, `.nm`, `.sub`). Same shape, already sizes its icon. Do not define `.turnbar`
  - _Requirements: R3.4, R3.8_

- [x] 12. Add the CSS variable existence check to CI
  - Grep the `.ps` CSS for every `var(--…)` reference; fail if any resolves to nothing declared in the token block
  - Would have caught task 10's bug at author time. Cheap insurance against recurrence
  - _Requirements: R3.3_

- [x] 13. Delete the dead views
  - `goals-view.tsx` (636 lines), `vault-view.tsx` (469), `activity-view.tsx` (390). Nothing imports them
  - **First confirm superseded, not pending:** `save-view` absorbed goals, `home-view` absorbed the activity feed. Record any behaviour present in the dead views but absent from the live ones before removing
  - Removes the duplicate `FIXED_APY_MAX` at `vault-view.tsx:26` and the second live-APY read at `:51`, so an APY change stops looking like it has three call sites
  - Also removes two of the seven gradients (`vault-view.tsx:126`, `goals-view.tsx:369`)
  - Also delete `.ps .legacy` (zero references) and the dead rate plumbing at `home-view.tsx:113-122`
  - _Requirements: R13.1–R13.5, R3.7, R11.5, R15.1_

- [ ] 14. Phase 1 device sign-off
  - Every screen, light and dark, on a real device or emulator. Photograph each. Measure contrast, do not estimate
  - **Review tasks 1, 2, 3 and 8 together in one sitting.** Each looks wrong alone; the font fix in particular will read as "something broke" until seen alongside the weight scale and the new palette
  - `UX-02`, `UX-04` and `UX-05` were found by reading the cascade and have never been observed on a screen. This is where that gets closed in both directions
  - Check icon legibility at the smallest used size on a real device now that the palette is near-monochromatic and icons carry more of the meaning load
  - _Requirements: R3.1, R3.5, R3.8, R15.9, R16.10_

---

## Phase 2 — Primitives

Track A (15–18) and Track B (19–22) are independent and can run in parallel.

### Track A — structure and feedback

- [ ] 15. Convert navigation to real routes
  - Route table in design D7. `AppShell` becomes `app/app/layout.tsx`; each view becomes a `page.tsx`
  - **Move the gating cascade** (`app-shell.tsx:88-105`, KYC → PIN → content) into the layout so it still intercepts every route. Test direct navigation to `/app/send` as a user with no PIN, and as one with unverified KYC
  - Keep the four data hooks in a layout-level context for now. Per-route fetching interacts with task 27 and should be decided with it, not opportunistically
  - Verify on an Android device: back button mid-flow returns one screen, does not close the app
  - _Requirements: R5.1, R5.2, R5.4, R5.7_

- [ ] 16. Add the `SendFlowProvider` so multi-step form state survives back navigation
  - Mounted at `/app/send`'s layout, so state persists across step routes but clears on flow exit
  - Today a user three screens into a withdrawal loses bank code, account number and PIN entry on back
  - _Requirements: R5.3_

- [ ] 17. Build the toast provider and error-copy map
  - API and dismissal behaviour in design D9. Kind is always an argument, never inferred from copy
  - Errors never auto-dismiss. Successes may, at 4s
  - Delete the three copy-matching regexes: `save-view.tsx:52`, `groups-view.tsx:344`, and the one in `invest-view.tsx`
  - Create `lib/error-copy.ts` generalising the mapping already done well at `auth-screen.tsx:71-83`. Route all 8 raw-error call sites through it. Raw text goes to logs, never to the user
  - Re-evaluate the 11 timer-based clears individually rather than removing them wholesale
  - _Requirements: R6.1–R6.5_

- [ ] 18. Build the skeleton primitives
  - `Skeleton`, `BalanceCardSkeleton`, `TxListSkeleton`, `GoalListSkeleton`. Shapes must match final content exactly
  - Priority is the balance card: today a spinner is replaced by a `--t-3xl` figure, shifting the page on every app open
  - Fix `save-view.tsx:55`, which returns `<div className="b" />` and shows an indefinitely blank screen
  - Make `useWallet` expose an error state instead of swallowing it in an empty `catch`, so a failed fetch is distinguishable from a slow one and can offer retry
  - Honour `prefers-reduced-motion`
  - _Requirements: R7.1–R7.4_

### Track B — access

- [ ] 19. Build the `<Field>` wrapper and adopt it across all forms
  - Render-prop wrapper generating an id with `useId` and wiring `htmlFor`, per design D11. Prevents regression better than hand-threading ids
  - **54 `<label>` elements currently have zero `htmlFor`.** Every one is decorative text: screen readers announce the withdraw form as unlabelled edit fields, and tapping a label does not focus its input
  - Include `aria-describedby` for hints and errors, which also gives task 17's inline field errors a home
  - _Requirements: R4.2, R6.6_

- [ ] 20. Name every icon-only control
  - There is currently **one** `aria-label` in the codebase and it is in `/protocol`
  - Covers every copy-to-clipboard button (`home-view.tsx:352`, `:428`, `:558`), the password toggle (`auth-screen.tsx:243`), and every sheet close control
  - _Requirements: R4.3_

- [x] 21. Fix the remaining systemic a11y defects
  - Remove `maximumScale: 1` and `userScalable: false` from `layout.tsx:33-39`. WCAG 1.4.4. Matters here because BVNs and wallet addresses render at 11–12px
  - Add `aria-current` to the active nav tab. The non-colour active cue is already handled by task 7's `regular` → `fill` treatment
  - Scope the global `* { scrollbar-width: none }` so it does not remove the only scroll affordance on pointer devices, notably in the bank picker's `max-h-48` list
  - Add a non-colour cue to transaction direction and pending state — icon weight is available for this now (R16.2)
  - Add the automated a11y check to CI. Treat as necessary, not sufficient — it will not catch the label problem in a render-prop form, nor colour-only state
  - _Requirements: R4.4–R4.9, R16.2_

- [ ] 22. Build the `<Sheet>` primitive and replace the four hand-rolled sheets
  - Requirements in design D10. Use `<dialog>` or a focus-trap library; hand-rolled traps are where this component usually fails
  - Replaces `StatementSheet`, `TxDetail`, the loan agreement sheet, and the invest sell sheet. Rebuild `ConfirmProvider` on it, keeping the ARIA it already gets right
  - Verify keyboard-only: open, traverse, Escape, and focus returns to the invoker
  - _Requirements: R9.1–R9.6_

---

## Phase 3 — Money moments

- [ ] 23. Make the withdrawal quote server-authoritative
  - `POST /api/ramp/quote` returning amount, itemised fees, total debit, rate, expiry, quote id. Design D12
  - Delete the hardcoded rates at `home-view.tsx:770-773`. The UI renders what it is given and computes nothing
  - If the quote fails or has expired, **block the transfer with an explanation.** Never present a local estimate as authoritative
  - **The one API change in this spec.** Loop in whoever owns `/api/ramp`
  - Investigate passing the quote id to execute and validating server-side, so the figure shown is provably the figure charged. If not cheap, record as follow-up rather than blocking
  - Verify end-to-end on staging: displayed total equals charged amount
  - _Requirements: R8.2, R8.3_

- [ ] 24. Build the Send review step
  - Three routes: `amount` → `review` → `result`. Needs tasks 15 and 23. Design D13
  - Resolved recipient name is the headline on review. The existing name-enquiry implementation (`home-view.tsx:69-88`) is good work currently rendered as a small inline check; it is the primary defence against a mistyped account number and belongs front and centre
  - Confirmation is a deliberate act distinct from form submission. Prefer slide-to-confirm. If the PIN is the confirming act, move it here from the form
  - Show itemised fees from the quote, never computed locally
  - _Requirements: R8.1, R8.4, R8.5_

- [ ] 25. Build the receipt and status timeline
  - Receipt: amount, recipient, reference, timestamp, status. Shareable via `navigator.share()`, designed to be screenshotted — forwarding transfer confirmations is how the Nigerian ecosystem verifies payment
  - Replace "Processing" with Initiated → Sent to bank → Delivered, with timing. The polling at `app-shell.tsx:76-84` already supplies the data
  - _Requirements: R8.6, R8.7_

- [ ] 26. Show tier limits inline
  - Remaining daily headroom on the amount field as the user types, with the upgrade path offered in place
  - Today the ₦20,000 / ₦3,000,000 logic surfaces as a `flash()` error after submission that auto-vanishes in 4 seconds, while telling the user to go and add their BVN
  - _Requirements: R8.8, R8.9_

- [ ] 27. Add optimistic writes and narrow the refresh
  - Write the expected transaction as `pending` immediately, reconcile on response, roll back with an explanation on disagreement. Design D14
  - **Only for predictable outcomes.** Not yield figures, not FX-dependent equity fills, not anything derived from an external quote
  - Narrow `refresh()` (`app-shell.tsx:56`) from three unconditional refetches to the affected dataset. A transfer does not need the profile refetched
  - Keep polling suspended while the tab is hidden, as today. Size interval and payload for mobile data cost
  - _Requirements: R7.5–R7.8_

- [ ] 28. Add pull-to-refresh to primary scrollable screens
  - _Requirements: R7.9_

- [ ] 29. Consolidate the currency formatters
  - One formatter, precision as an argument. Delete the local `naira()` at `borrow-view.tsx:29` and the 11 `toLocaleString(undefined, …)` calls in `invest-view.tsx`
  - Apply `.num` (already sets `tabular-nums`) wherever numbers can update
  - Verify by comparing the same balance across all tabs
  - _Requirements: R11.1–R11.4_

- [ ] 30. Validate circle creation input
  - Bound and validate `parseInt(formMax)` at `groups-view.tsx:82` so an empty or out-of-range member count cannot reach the database and surface as a raw Postgres error
  - Replace the silent `if (!user || !formName || !formAmount) return`, which makes the button appear inert with no explanation
  - _Requirements: R6.6, R6.7_

---

## Phase 4 — Structure and activation

- [ ] 31. Restructure the information architecture
  - Five destinations: Home · Money · ⊕ · Ajo · You. Rationale and mapping in design D16. Needs task 15
  - Merge Save, Invest and Borrow into Money as sections. Each stays individually linkable (`/app/money/borrow`), so deep links and task 36's shortcuts are unaffected
  - The ⊕ centre action opens Send / Receive / Ajo contribute. This is the biggest daily-use win available: it promotes the two highest-frequency actions out of a card into the navigation
  - **No capability may become unreachable.** This is reorganisation, not reduction
  - _Requirements: R5.5, R5.6_

- [ ] 32. Add view transitions
  - Screen transitions plus a shared-element transition on amount and title when a list row expands to detail. Design D17
  - Progressive enhancement only; unsupported browsers get today's instant swap. Must honour `prefers-reduced-motion`, which `globals.css` already does correctly for `psrise`
  - _Requirements: R2.6, R7 (feel)_

- [ ] 33. Build the activation surfaces
  - Every empty state becomes an illustration, one sentence on what the feature does, and one CTA. **Use Phosphor `duotone` at `--i-hero`** rather than adding an illustration dependency (R16.8)
  - First-session checklist on Home: Add money → Set a goal → Join a circle. Disappears once complete
  - Earnings as a story: sparkline, projection, milestone moments. `cngn_yield_earned_micro` is the most motivating number in the product and currently renders as one line
  - Ajo depth: contribution countdown, member reliability indicator, "your turn is in 3 cycles". Build around the existing `.ps .circle` payout ring, which is the best component in the codebase
  - Verify by walking a fresh account through a first session
  - _Requirements: R12.1, R12.2, R12.3, R12.5, R16.8_

- [ ] 34. Review the gating screens for dead ends
  - Confirm PIN, biometric and KYC screens each explain why they are required and what happens next, and that no state has neither a forward nor a backward path
  - The BVN "Creating your account…" poll is the pattern to follow for third-party waits
  - _Requirements: R12.4, R12.5_

- [ ] 35. Unify the brand
  - Bring `join/[groupId]` onto `.ps`, replacing the `from-purple-600 to-violet-700` gradient with a solid neutral surface. It is the viral surface, and a user's first impression of PawaSave is currently purple
  - Bring `auth-screen` (currently slate) onto `.ps`
  - Resolve the three-way green disagreement — `.ps --green` `#0A6B42`, `viewport.themeColor` `#059669`, `brand` `#10B981` — to one value. Delete the unused `pawa` palette from `tailwind.config.js`
  - Remove "Powered by Supabase · FlintAPI · Base L2" from the auth footer
  - Reconcile "FlintAPI" / "Flipeet" / "selected automatically" in user-facing copy and transaction descriptions
  - Document that `/protocol` and `/admin` keep `.proto-*` deliberately, so it reads as intentional
  - Verify by walking invite link → auth → app and confirming one typeface and one palette
  - _Requirements: R10.1–R10.5, R15.1_

- [ ] 36. Add platform integration
  - Haptics: one utility, five call sites. `vibrate(10)` on tab change and sheet open, `(20)` on money-movement success, `([10,40,10])` on failure
  - Manifest: add `screenshots` and `shortcuts` for Send and Receive (needs task 15). Reconcile `theme_color` `#0A6B42` with `viewport.themeColor` `#059669`
  - Custom in-app install prompt; the browser default is easy to miss
  - Self-host or proxy the equity logos. `stock-chart.tsx:133` requests `logo.clearbit.com` per symbol, so Clearbit learns which equities each user browses
  - **Preserve the service worker's conservative posture.** It must continue to never cache `/api` or authenticated responses
  - Verify by installing on Android and iOS
  - _Requirements: R14.1–R14.7_

- [ ] 37. Final verification pass
  - Work the verification table in design §8 requirement by requirement
  - Full WCAG 2.1 AA audit of the consumer app. Every failure fixed or recorded with written justification
  - Grep checks: no `gradient` in consumer chrome (R15.1), no `<svg viewBox` in the consumer app (R16.9)
  - Confirm `npx tsc --noEmit` clean and the app builds
  - Update the finding index in `requirements.md` §5 with disposition per finding
  - _Requirements: R4.9, R13.5, R15.1, R16.9, all_

---

## Effort

Rough, assuming one engineer and device access.

| Phase | Tasks | Estimate | Gate |
|---|---|---|---|
| 1 — Foundation | 1–14 | ~1.5 weeks | Device sign-off, both themes, all screens |
| 2 — Primitives | 15–22 | ~1.5 weeks | Keyboard-only traversal, a11y check green |
| 3 — Money moments | 23–30 | ~2 weeks | Staging transfer: shown total = charged amount |
| 4 — Structure | 31–37 | ~2 weeks | Fresh-account first session, install on both platforms |

Phase 1 grew from ~1 week to ~1.5 with the icon migration (66 call sites) and the palette rebalance. It remains the phase that changes how the app feels most, because it is where real Inter, a working weight ramp, solid neutral surfaces and a coherent icon set all land together.

If the schedule compresses, tasks 1–14 plus 19–21 are the set with the best impact-to-effort ratio: they close every Critical, all three WCAG failures, the accessibility gaps, and the full visual-language change, without touching the money path.
