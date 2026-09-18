# Frontend UX Elevation: Design

**Spec:** `frontend-ux-elevation`
**Requirements:** `requirements.md` (R1–R16)
**Status:** Design — awaiting review before `tasks.md`

---

## 1. Approach

Four phases. Phase 1 is a hard prerequisite for everything else; the remaining three overlap but are sequenced by dependency.

```
        ┌────────────────────────────────────────┐
        │ Phase 1 — FOUNDATION                   │  R1, R2, R3,
        │  font fix · token scales · palette      │  R13, R15, R16
        │  (solid, mono) · icon system ·          │  BLOCKS EVERYTHING
        │  home-view port · theme bugs · dead code│
        └───────────────────┬────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
┌───────────────────────────┐   ┌───────────────────────────┐
│ Phase 2 — PRIMITIVES      │   │ Phase 2b — ACCESS         │
│  routing (R5)             │   │  focus rings (R4.1)       │
│  <Sheet> (R9)             │   │  labels + ids (R4.2)      │
│  toast (R6)               │   │  aria names (R4.3)        │
│  skeletons (R7.1-4)       │   │  viewport (R4.4)          │
└─────────────┬─────────────┘   └─────────────┬─────────────┘
              └──────────────┬────────────────┘
                             ▼
        ┌────────────────────────────────────────┐
        │ Phase 3 — MONEY MOMENTS                │  R8, R7.5-9, R11
        │  server quotes · review step           │
        │  receipts · timelines · optimistic UI  │
        └───────────────────┬────────────────────┘
                            ▼
        ┌────────────────────────────────────────┐
        │ Phase 4 — STRUCTURE & ACTIVATION       │  R5.5-6, R10, R12, R14
        │  IA · transitions · empty states       │
        │  brand unification · PWA polish        │
        └────────────────────────────────────────┘
```

Three principles govern the decisions below.

**Complete the system; do not replace it.** The `.ps` layer is the approved look and five views already honour it. Every decision here either fills a gap in it or brings a stray screen into it. No new visual language is introduced.

**Fix the cause, not the symptom.** The flat typographic hierarchy reads as a type-scale problem. It is a font-loading problem (D0). Two of the four Critical theme bugs read as styling problems. They are undefined-token problems. Diagnose to the token layer before writing CSS.

**Extend patterns already proven in this codebase.** `auth-screen.tsx:71-83` already maps provider errors to human copy. `ConfirmProvider` already gets dialog ARIA right. The BVN onboarding poll already handles "waiting on a third party" well. Three of the larger pieces below are those patterns generalised, not inventions.

---

## 2. Blocking prerequisite: the font

### D0 — Fix font loading before touching the type scale

Evidence is in `requirements.md` §3.1: the built CSS contains eight `@font-face` blocks, all named `__Inter_f367f3` or `__Inter_Fallback_f367f3`, and none named `Inter`. `.ps` asks for `"Inter"`. It resolves to nothing and falls to `ui-sans-serif`.

```tsx
// layout.tsx
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',   // exposes the generated family to CSS
  display: 'swap',            // never block first paint on the font
})

// <body className={inter.variable}>   ← .variable, not .className
```

```css
.ps { --sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif; }
```

Note `inter.variable` rather than `inter.className`. `.className` sets `font-family` directly on `<body>`, which `.ps` then overrides. `.variable` only declares the custom property, letting `.ps` consume it deliberately. Keep `body`'s own `font-family` declaration in `globals.css` pointing at the same variable so the auth screen and `/protocol` stay consistent.

**Why this must land first.** Roboto and SF do not provide weight 650 or 680, so those snap to 700 today. Once real Inter loads, they resolve as distinct weights and *every heading in the app changes weight simultaneously*. Any type calibration done before this is measured against the wrong font and against a two-step weight ramp that is about to become four. This is R1.7.

**Amended during implementation: the font is vendored, not fetched (`UX-47`).** Trying to verify task 1 locally surfaced a second, worse problem. `next/font/google` downloads during the build, and when it cannot reach `fonts.googleapis.com` it prints a warning, emits a metric-matched fallback, and **exits 0**. Observed directly:

```
⨯ Failed to download `Inter` from Google Fonts. Using fallback font instead.
```

A network blip in the Coolify Docker build would therefore ship the wrong typeface with a green build. That is the same silent-degradation failure mode task 1 exists to fix, one layer down.

So the final implementation uses `next/font/local` against a vendored file:

```
src/app/fonts/inter-latin-variable.woff2   48KB, latin, wght 100-900
src/app/fonts/Inter-LICENSE.txt            OFL-1.1
```

Sourced from `@fontsource-variable/inter@5.3.0` rather than Google, and committed. The build now has no third-party network dependency, is faster, and cannot degrade silently. Emitted `@font-face` carries `font-weight:100 900`, so the whole weight axis is present and 400/500/600/700 each resolve distinctly.

**Verification is runtime, not static.** Open devtools, select an element inside `.ps`, read computed `font-family`. Expect `__inter_365cbc`. This gates the phase.

---

## 3. Phase 1 design — foundation

### D1 — Token scales (R2)

Added to the `.ps` block alongside the existing colour tokens. Dark theme overrides only what must change: elevation.

```css
.ps {
  /* ── type: 19 sizes → 8, no fractional steps, 11px floor ── */
  --t-2xs:11px;  /* nav labels, metadata. was 9/10/10.5/11 */
  --t-xs:12px;   /* captions, helper text. was 11.5/12 */
  --t-sm:13px;   /* secondary body. was 12.5/13 */
  --t-md:14px;   /* primary body. was 13.5/14/14.5 */
  --t-lg:16px;   /* emphasis, list titles. was 15/16 */
  --t-xl:20px;   /* screen headings. was 19/22 */
  --t-2xl:28px;  /* section figures. was 28/29 */
  --t-3xl:36px;  /* hero balance. was 33/39 */

  /* ── weight: real Inter steps only ── */
  --w-normal:400; --w-medium:500; --w-semi:600; --w-bold:700;

  /* ── space: 4px base ── */
  --s-1:4px; --s-2:8px; --s-3:12px; --s-4:16px;
  --s-5:20px; --s-6:24px; --s-8:32px; --s-10:40px;

  /* ── radius: 11 values → 5 ── */
  --r-sm:8px; --r-md:12px; --r-lg:16px; --r-xl:22px; --r-full:999px;

  /* ── elevation: 3 levels ── */
  --e-1:0 1px 2px rgba(19,26,21,.04);
  --e-2:0 1px 2px rgba(19,26,21,.04),0 10px 28px -14px rgba(19,26,21,.12);
  --e-3:0 2px 4px rgba(19,26,21,.06),0 20px 48px -20px rgba(19,26,21,.18);

  /* ── motion ── */
  --dur-fast:120ms;   /* state change: press, toggle */
  --dur-base:200ms;   /* enter/exit: sheet, toast */
  --dur-slow:320ms;   /* screen transition */
  --ease-out:cubic-bezier(.2,.7,.2,1);      /* already in use by psrise */
  --ease-spring:cubic-bezier(.34,1.4,.64,1); /* overshoot for confirmations */
}
```

Three notes on the mapping.

**The 11px floor is a real change, not a rename.** Today's 9px nav labels and 10.5px metadata both rise. That is intentional (R4.6) and will slightly increase the height of the nav and some rows. Expect to re-check the `.ps .b` bottom padding of 96px after.

**`--shadow` is retained as an alias for `--e-2`** during the phase so the ~12 existing references keep working, then removed once migrated. Avoids a big-bang CSS edit.

**Dark theme overrides elevation only.** The existing dark block already redefines every colour. It gains `--e-1/2/3` with the darker values currently in its `--shadow`.

### D2 — Remove the global weight overrides (R1.5)

```css
/* delete */
body { font-weight: 600; }
p, span, label { font-weight: 600; }
```

These make regular weight unreachable, which is why the design compensates with font-size micro-steps. Body becomes 400. Every component that needs emphasis states it via `--w-medium` or `--w-semi`.

This will make the app look noticeably lighter on first run and is the change most likely to prompt "did something break". It did not. Review it together with D0 and D1, on device, in one sitting, because all three interact.

### D3 — Focus ring (R4.1)

Zero `:focus-visible` rules exist today, and `.field` sets `outline:none`. One rule fixes the whole app:

```css
.ps :focus-visible {
  outline: 2px solid var(--green);
  outline-offset: 2px;
  border-radius: var(--r-sm);
}
.ps .field:focus-visible { outline-offset: 0; } /* inputs already have a border */
```

`:focus-visible` rather than `:focus` so pointer users do not see rings on tap. Remove the bare `outline:none` from `.field` and let the border-colour change remain as an additional cue.

### D4 — Porting `home-view` (R3.2)

The single largest Phase 1 task and the one that fixes the Critical dark-mode failure. `home-view.tsx` is 1,048 lines with six sub-screens holding 152 hardcoded light-theme classes.

**The vocabulary already exists.** No new CSS is needed. The mapping is mechanical:

| Current Tailwind | `.ps` primitive |
|---|---|
| `text-lg font-bold text-slate-900 mb-1` | `.h2` |
| `text-sm text-slate-400 mb-5` | `.p` |
| `flex items-center gap-1 text-sm text-slate-500 mb-4` | `.back` |
| `w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl …` | `.field` |
| `text-xs text-slate-500 block mb-1.5` | `.lab` |
| `w-full mt-6 bg-emerald-600 … py-3.5 rounded-xl …` | `.cta` |
| `bg-emerald-50 border border-emerald-200 rounded-2xl p-4/5` | `.info` |
| `bg-amber-50 border border-amber-200 rounded-xl px-4 py-3` | `.note` |
| `px-4 py-2.5 rounded-xl text-sm bg-red-50 text-red-700` | `.flash.err` |
| `bg-white border border-slate-200 rounded-2xl p-4` (chooser rows) | `.rows` + `.opt` |

**Sequencing within the task.** Port one sub-screen at a time, verifying each on device in both themes before starting the next: `deposit-choose` → `deposit-naira` → `deposit-crypto` → `deposit` → `deposit-info` → `withdraw`. `withdraw` is last because it is the largest and depends on the bank-picker treatment.

**Two things to resist.** Do not restructure the flow while porting; that is Phase 3 (D11). Do not fix the hardcoded fee maths here either; it needs the server quote endpoint. Port only, so the diff stays reviewable.

**Extract while porting.** The bank search-and-select control (`home-view.tsx:670-720`) is a genuinely good pattern — searchable list with a select fallback — and it will be wanted elsewhere. Lift it to `components/ui/bank-picker.tsx`.

### D5 — The three theme bugs (R3.3, R3.4)

All three are token or CSS-existence failures, not visual design problems.

**`UX-04`, invisible invite code.** `groups-view.tsx:246-250` references `var(--card, #12140f)` and `var(--sub, #8a9a90)`. Neither property exists; the system uses `--surface` and `--muted`. The fallbacks fire, giving a near-black panel, while `--ink` *does* exist and resolves to near-black text in light mode. Fix: use `--surface`/`--muted`, and replace the inline styles with `.info`, which is exactly this component.

**`UX-05`, unstyled manager banner.** `groups-view.tsx:289` uses `className="turnbar"`, which no rule defines. Because `.ps .turnbar .ic svg` also does not exist, the inline SVG renders at intrinsic full width. Fix: rebuild the markup on `.rows` + `.row` (`.dot`, `.mid`, `.nm`, `.sub`), which is the same shape and already sizes its icon. Do not define `.turnbar`; there is no reason for a bespoke class here.

**`UX-06`, blank Save screen.** `save-view.tsx:55` returns `<div className="b" />`. Fix with the skeleton from D8. Also address the cause: `useWallet` swallows its error in an empty `catch`, so a failed fetch is indistinguishable from a slow one. It must expose an error state (R7.4).

**Guard against recurrence.** Add a CI check that greps the `.ps` CSS for every `var(--…)` reference and fails if any resolves to nothing declared in the token block. Cheap, and it would have caught `UX-04` when it was written.

### D21 — Solid surfaces and a near-monochromatic palette (R15)

**The inventory is smaller than it looks.** Seven gradients exist; only three are live and in scope.

| Location | Gradient | Disposition |
|---|---|---|
| `globals.css:110` `.ps .acct` | `158deg, --card-a, --card-b` | **In scope.** Home hero balance card |
| `globals.css:171` `.ps .pool` | same | **In scope.** Save pool card |
| `join/[groupId]:129` | `from-purple-600 to-violet-700` | **In scope.** Already being rebranded in D19 |
| `globals.css:238` `.ps .legacy` | 3-stop green→slate | Dead CSS, deleted in D6 |
| `vault-view.tsx:126` | amber→orange→rose | Dead file, deleted in D6 |
| `goals-view.tsx:369` | emerald→teal→slate | Dead file, deleted in D6 |
| `admin-view.tsx:210` | `emerald-600→teal-700` | `/admin`, out of scope |
| `logo.tsx:13` | `<linearGradient>` inside the mark | **Brand decision, not a UI one.** See below |

So the work is two CSS rules plus one page already scheduled for rebrand.

**The real change is what the accent is for.** Today `--green` fills the largest surface on both Home and Save. When the accent is also the dominant surface, there is no accent left — nothing can stand out against it, which is why the current design leans on translucent white chrome to create any hierarchy inside those cards.

Neutral-dominant inverts that:

```css
.ps {
  --hero:#131A15;          /* solid, near-black. was --card-a/--card-b gradient */
  --on-hero:#FFFFFF;
  --on-hero-muted:#A8B0AA; /* replaces rgba(255,255,255,.72) */
  --on-hero-fill:#20291F;  /* replaces rgba(255,255,255,.16) on .ab and .apy */
  --on-hero-line:#2C352E;  /* replaces rgba(255,255,255,.4) on .acct-chip */
}
```

Four consequences worth stating plainly.

**Name it `--hero`, not `--card`.** `groups-view.tsx:246` currently references `var(--card, #12140f)`, an undefined property whose fallback is the cause of `UX-04`. Introducing a real `--card` token would silently turn that bug into a *different* wrong result — a dark panel where a light `.info` panel belongs — and it would stop looking like a bug. Fix `UX-04` first (D5), and avoid the name entirely.

**Dark theme differentiates by elevation, not hue (R15.8).** A near-black hero on a `#0D1411` background disappears. In dark theme `--hero` becomes `--surface-2` with `--e-2` and a `--line` border. This is the correct monochromatic answer: depth comes from elevation and edge, not from colour.

**Delete the gloss.** `.ps .acct::after` is a 170px translucent white circle bled off the card corner. It exists only to make a gradient look glossy. With a solid fill it has no job.

**Contrast must be re-measured, not assumed (R15.9).** Changing a gradient to a solid changes the effective background behind every element on that card. The `--on-hero-muted` value above is a starting point, not a verified one.

**Semantic colour discipline (R15.5, R15.6).** After this change the palette is: one neutral ramp (8 steps, already good), one accent (`--green`) meaning positive movement and primary action, `--neg` for destructive and failure, `--amber` for warning and pending. Nothing else, and none of them decorative. Note `--pos` is currently an alias of `--green`; keep the alias so intent stays readable at call sites.

**The logo is a separate decision, now closed (R15.10).** The mark keeps its gradient as a deliberate brand-only exception and is being reworked in deep blue → deep green with a glassy treatment. See D23. A gradient confined to the logo reads as intentional; a gradient in the logo *and* the chrome is what reads as dated.

### D22 — One icon system (R16)

**Current state is two systems.** 39 distinct `lucide-react` icons across 14 files, plus 27 hand-rolled inline `<svg viewBox>` icons across 8 files — including all six navigation glyphs in `app-shell.tsx:16-22`. The hand-rolled set does not share lucide's optical grid or terminal treatment, so they read as slightly off next to each other.

**One is factually wrong.** `NavBorrow` (`app-shell.tsx:22`) draws `M12 2v20` plus an S-curve: a **dollar sign**, in the primary navigation of a naira product. This is the clearest example of the icon set being not merely generic but incorrect.

**Decision: adopt Phosphor, for the weight axis rather than the aesthetics.**

Phosphor ships six weights — thin, light, regular, bold, fill, duotone — and that single property resolves three otherwise-separate requirements:

| Requirement | Without a weight axis | With one |
|---|---|---|
| R4.5 non-colour active nav state | Bolt on an underline or dot indicator | `regular` inactive → `fill` active |
| R4.8 non-colour status indication | Add a glyph or text label per state | Weight change carries it |
| R12.1 empty states need illustration | Add an illustration dependency | `duotone` at 48–64px |

It also pairs with the rest of Phase 1: Phosphor's `regular` is optically lighter than lucide's default stroke, which suits body text dropping to weight 400 (D2) and a neutral-dominant palette (D21). The three changes move in the same direction rather than fighting.

**Centralise the defaults (R16.7).** Phosphor's `IconContext` sets size and weight app-wide, so call sites stop repeating `className="w-4 h-4"`:

```tsx
<IconContext.Provider value={{ size: 20, weight: 'regular' }}>
```

Add a size scale to the token layer (R16.6), replacing the ad-hoc 16/17/20/24 mix:

```css
--i-sm:16px; --i-md:20px; --i-lg:24px; --i-xl:32px; --i-hero:56px;
```

**Metaphors: fix what is wrong, keep what is recognisable (R16.4).** This is the part most likely to be over-corrected. Navigation and primary actions should use boring, instantly legible metaphors; identification speed matters more than freshness. Personality belongs in the weight and fill treatment and in duotone empty states, not in clever nav glyphs.

| Location | Today | Proposed | Why |
|---|---|---|---|
| Borrow nav | hand-drawn **dollar sign** | `HandCoins` or `Scales` | Currently wrong for the market |
| Ajo nav | generic two-person glyph | `UsersThree`, or a circle-of-dots echoing `.ps .circle` | Ajo is culturally specific and the payout ring is the app's best component; the nav icon can reference it |
| Home / Save / Invest / You | house / card / line-up / person | Phosphor equivalents, metaphor unchanged | Recognisable already. Do not chase novelty |

**Verify before committing to it (R16.9).** Two things are unverified and should be settled in the first task, not assumed:

1. **Bundle size and import strategy.** `@phosphor-icons/react` v2 with Next 14 App Router needs the right entry point for SSR and effective tree-shaking. Measure before and after; do not take tree-shaking on faith.
2. **Legibility at `--i-sm`.** Phosphor's lighter stroke is an advantage at 20px and above, and a risk at 16px on a low-density screen. Check on a real device (R16.10), and if 16px `regular` is too light, the fix is `bold` at small sizes, not abandoning the library.

Roughly 66 replacement sites (39 lucide + 27 hand-rolled). Do this **before** the `home-view` port (D4), or that file gets touched twice.

### D23 — The logo mark (R15.10)

The one place in the system where a gradient is kept, deliberately.

**Before:** navy tile `#0A0E1A` with the mark in a teal→emerald gradient (`#2DD4C4` → `#12B981`). The gradient sits on the letterform, which is the wrong surface for it — at 32px, the most common render size, thin strokes carry no visible gradient at all. The colour was doing nothing at the size it is mostly seen.

**After:** the tile carries the gradient, the mark is knocked out of it.

```
tile      deep blue #0A2A4A → pivot #0A4A52 → deep green #0A6B42  (diagonal)
sheen     white 22% → 5% → 0%, top-left diagonal sweep
rim       white 50% top edge → 8% mid → 14% bottom (inner stroke)
mark      near-white at 95%, counters masked out so the tile shows through
```

Three reasons the treatment moved to the tile:

1. **Glass needs surface area.** Highlights and rim light are invisible on a letterform stroke and legible on a 512px tile. This is what makes it read as glass rather than as a gradient.
2. **Colour survives downscaling.** At 32px the tile is still ~1,000 visible pixels of gradient; the mark's strokes are 4px wide.
3. **The deep green endpoint is `--green`.** The logo terminates on the exact brand accent, so the mark and the UI share an anchor even though the UI is otherwise near-monochromatic.

**Blue is quarantined.** This introduces a hue that exists nowhere else in the system. It is legitimate in a brand mark and illegitimate in UI chrome. Blue must not appear in any surface, control, state or icon. Pulling it into the palette later is a separate decision.

**Two incidental fixes.** The gradient `id` was hardcoded as `pawa-b`, so two logos on one page produced colliding SVG ids and the second could inherit the first's definition; ids are now generated with `useId`. And the counters were filled with the old flat navy, which would have painted solid patches over the new tile — they are now a mask so the gradient shows through.

**Noted, not acted on:** the mark draws a **B**, not a P or an S. That looks like it predates the PawaSave name. Out of scope here, worth a brand decision separately.

### D6 — Dead code (R13)

Delete `goals-view.tsx` (636), `vault-view.tsx` (469), `activity-view.tsx` (390). Nothing imports them; `app-shell.tsx` imports only the six live views.

Confirm superseded, not pending, before deleting: `save-view` absorbed goals, `home-view` absorbed the activity feed. Record anything present in the dead views but absent from the live ones. `vault-view.tsx:26` also declares its own `FIXED_APY_MAX = 40`, and `vault-view.tsx:51` a second live-APY read, which is why an APY change currently looks like it has three call sites.

Also delete `.ps .legacy` (zero references) and the dead rate plumbing at `home-view.tsx:113-122`.

---

## 4. Phase 2 design — primitives

### D7 — Routing (R5)

Today `tab` lives in `app-shell.tsx:60` and Home's `view` in `home-view.tsx:30`, both `useState`. Nothing touches the URL, so Android back closes the app mid-withdrawal.

**Decision: real routes, not query params.**

```
/app                    → Home
/app/money              → Money (Save · Invest · Borrow sections)
/app/money/save
/app/money/invest
/app/money/borrow
/app/ajo
/app/ajo/[groupId]
/app/you
/app/send               → step: amount → review → result
/app/receive            → rail chooser → naira | crypto
```

Query params would have been less work, but routes give parallel layouts, per-route loading UI, and View Transitions (D14) for free, and this app will want all three.

**Migration path.** `AppShell` becomes `app/app/layout.tsx` holding the shell, nav, gating and shared data. Each view becomes a `page.tsx`. The gating cascade at `app-shell.tsx:88-105` (KYC → PIN → content) moves into the layout so it still intercepts every route.

**Preserve in-flight form state (R5.3).** Send is multi-step and its state must survive back navigation. Keep it in a `SendFlowProvider` mounted at `/app/send`'s layout rather than in `useState` inside a page, so it persists across step routes but clears on flow exit.

**Watch item.** `app-shell.tsx` currently holds four data hooks and passes results down as props. Moving to routes means either a shared context in the layout or per-route fetching. Prefer context for now; per-route fetching interacts with R7.7's narrowed refresh and should be considered together, not opportunistically.

### D8 — Skeletons (R7.1–7.4)

Replace every centred `<Loader2 className="animate-spin" />` with a placeholder in the shape of the final content.

```tsx
<Skeleton className="…" />          // primitive: shimmer honouring prefers-reduced-motion
<BalanceCardSkeleton />             // matches .acct exactly, including the 36px figure
<TxListSkeleton rows={6} />         // matches .tx row height
<GoalListSkeleton />                // matches .goal
```

The requirement that matters is no layout shift on hydration (R7.2). The balance card is the priority: today a spinner is replaced by a `--t-3xl` figure, which shifts the page on every single app open.

Reuse the existing `psrise` easing token so skeleton-to-content feels like the rest of the system.

### D9 — Toast provider (R6)

Replaces per-component `useState` strings, the 11 timer-based clears, and the three separate copy-matching regexes (`save-view.tsx:52`, `groups-view.tsx:344`, `invest-view.tsx`).

```ts
toast.success('₦5,000 sent to Kemi Adeyemi', { action: { label: 'View receipt', onClick } })
toast.error('Bank partner unavailable', { action: { label: 'Retry', onClick } })
toast.info('Your account is being created', { persist: true })
```

Behaviour, derived directly from the acceptance criteria:

| Kind | Auto-dismiss | Rationale |
|---|---|---|
| `success` | 4s | R6.2 permits it |
| `info` | 6s, or `persist` | |
| `error` | **never** | R6.2. Requires explicit dismissal |

Kind is an argument, never inferred (R6.1). Every toast may carry one action (R6.3).

**Pair it with an error-copy map (R6.5).** Generalise the approach at `auth-screen.tsx:71-83`, which already does this well, into `lib/error-copy.ts`. All 8 raw-error call sites route through it. Unrecognised errors get a generic message plus a reference code; the raw text goes to logs, never to the user.

**Inline validation stays inline (R6.6).** Toasts are for outcomes. Field-level problems belong on the field. `home-view`'s current habit of routing amount and PIN validation through `flash()` is the pattern to break.

### D10 — Sheet primitive (R9)

One implementation replacing four: `StatementSheet`, `TxDetail`, the loan agreement, the invest sell sheet. `ConfirmProvider` is rebuilt on it, keeping the ARIA it already gets right.

```tsx
<Sheet open={open} onClose={close} title="Account statement" snapPoints={['auto', 'full']}>
```

Non-negotiables, all from R9: `role="dialog"` + `aria-modal`, focus moved in and trapped, focus restored to the invoker on close, Escape to close, body scroll lock, internal scrolling, drag-to-dismiss on touch, and a keyboard-reachable close control alongside backdrop dismissal.

Use a `<dialog>` element or a focus-trap library rather than hand-rolling the trap. Hand-rolled traps are where this class of component usually fails.

### D11 — Accessibility sweep (R4.2, R4.3)

Mechanical and large: 54 `<label>` elements with zero `htmlFor`, and one `aria-label` in the whole codebase.

Rather than hand-threading ids, introduce a `<Field>` wrapper that generates one with `useId` and wires the association, so this cannot regress:

```tsx
<Field label="Account Number" hint="10 digits" error={errors.account}>
  {(id) => <input id={id} className="field" inputMode="numeric" maxLength={10} … />}
</Field>
```

This also gives R6.6 inline field errors a home, and `aria-describedby` for hints and errors, which is otherwise a separate pass.

Add a CI accessibility check. Treat it as necessary, not sufficient (R4.9) — it will not catch the label problem in a render-prop form, and it will not catch colour-only state.

---

## 5. Phase 3 design — money moments

### D12 — Server-authoritative quotes (R8.2, R8.3)

`home-view.tsx:770-773` computes fees in the component:

```tsx
const networkFee = Math.max(0, Math.round(net / 0.99) - net) // Flipeet ~1% spread
const ourFee = Math.round(net * 0.015)                       // PawaSave 1.5%
```

This is the one API change in scope, and it is in scope because the review step (D13) would otherwise show a total the backend has not agreed to. That is the worst bug this spec could ship.

`POST /api/ramp/quote` returns amount, itemised fees, total debit, the rate used, an expiry, and a quote id. The UI renders what it is given and computes nothing. If the quote fails or has expired, the transfer is blocked with an explanation (R8.3) — no local estimate is ever presented as authoritative.

Ideally the quote id is passed to the execute call and validated server-side, so the figure shown and the figure charged are provably the same. Worth checking with whoever owns `/api/ramp` whether that is cheap; if not, it is a follow-up, not a blocker.

### D13 — Review step and receipt (R8.1, R8.4–8.7)

Send becomes three routes: `amount` → `review` → `result`.

**Review** shows resolved recipient name most prominently (R8.5). The existing name-enquiry implementation (`home-view.tsx:69-88`, debounced, with graceful manual fallback) is good work and currently renders as a small inline check; on review it becomes the headline, because it is the primary defence against a mistyped account number. Below it: bank, amount, itemised fees from the quote, total.

Confirmation is a deliberate act distinct from form submission (R8.4). Prefer slide-to-confirm over a second button; if the PIN is the confirming act, it belongs here rather than buried in the form as it is today.

**Result** is a receipt (R8.6): amount, recipient, reference, timestamp, status. Shareable via `navigator.share()`, and designed to be screenshotted, because forwarding transfer confirmations is how the Nigerian ecosystem verifies payment. A branded, screenshot-ready receipt is free distribution.

**Status timeline (R8.7).** Replace the word "Processing" with Initiated → Sent to bank → Delivered, with timing. This is the most anxious 90 seconds in the product and it currently has no progress indication. The polling already in `app-shell.tsx:76-84` supplies the data.

### D14 — Optimistic writes (R7.5–7.7)

Today every mutation awaits the server, then calls `refresh()` — defined at `app-shell.tsx:56` as `Promise.all([refreshWallet(), refreshTx(), refreshProfile()])` — then snaps. Three round trips per mutation, and again every 8s while a ramp is pending.

Write the expected transaction into local state immediately as `pending`, render it, reconcile on response. Roll back with an explanation if the server disagrees (R7.6).

**Only for predictable outcomes.** A transfer's own row is predictable. A yield figure, an FX-dependent equity fill, and anything derived from an external quote are not, and must not be optimistically rendered.

Narrow `refresh()` to the affected dataset (R7.7). A transfer does not need the profile refetched.

### D15 — Formatter consolidation (R11)

Three implementations disagree: `formatNaira` (`en-NG`, 0dp), a local `naira()` at `borrow-view.tsx:29` (2dp), and 11 `toLocaleString(undefined, …)` calls in `invest-view.tsx` that follow device locale. Same balance, different rendering per tab.

One formatter, precision as an argument (R11.3). Delete the other two. Ensure `.num` (which already sets `tabular-nums`) is applied wherever numbers can update, so digits do not shift (R11.4).

---

## 6. Phase 4 design — structure and activation

### D16 — Information architecture (R5.5, R5.6)

Six destinations today: Home, Save, Ajo, Invest, Borrow, Profile. At 9px labels, no `aria-current`, colour-only active state. The split does not match frequency: **Borrow** holds prime thumb real estate for a few-times-a-year action, while **Send** and **Receive** — the daily ones — are buried inside the Home hero card.

```
[ Home ]   [ Money ]   ( ⊕ )   [ Ajo ]   [ You ]
```

| Destination | Contains | Rationale |
|---|---|---|
| **Home** | Balance, activity, nudges | Unchanged |
| **Money** | Save · Invest · Borrow as sections | One mental model: capital deployed at a rate. They share balance context. Borrow becomes a section, not a tab |
| **⊕** | Send · Receive · Ajo contribute | Promotes the two highest-frequency actions out of a card and into the navigation, where thumbs already are. Biggest daily-use win available |
| **Ajo** | Circles | Earns a tab: social, deadline-driven, the differentiator |
| **You** | Profile, limits, KYC, security, theme, statements | Absorbs Profile |

Each merged section stays individually linkable (R5.6): `/app/money/borrow` still works, so existing deep links and the manifest shortcuts in R14.4 are unaffected.

No capability is removed (R5.5). This is reorganisation, not reduction.

### D17 — View transitions (R7 feel)

Once routing exists, use the View Transitions API for screen changes, with a shared-element transition on the amount and title when a list row expands to detail — for example a goal in Money, or a transaction in Home. Animating position rather than cross-fading is the single most native-feeling thing available on the web, and it is roughly 15 lines on top of D7.

Must honour `prefers-reduced-motion`, which `globals.css` already does correctly for `psrise`. Progressive enhancement only: unsupported browsers get an instant swap, which is today's behaviour.

### D18 — Activation surfaces (R12)

**Empty states become first actions.** Today: "No activity yet / Add money with Receive to get started" in a plain card. Each becomes an illustration, one sentence on what the feature does, and one CTA.

**First-session checklist on Home.** Add money → Set a goal → Join a circle. Disappears once complete. Activation is the metric that matters most at this stage and no UI currently serves it.

**Earnings as a story (R12.3).** `cngn_yield_earned_micro` currently renders as one line: `↑ ₦120 earned in savings`. It is the most motivating number in the product. Give it a sparkline, a projection, and a milestone moment at thresholds.

**Ajo depth.** Countdown to next contribution, member reliability indicator, "your turn is in 3 cycles" positioning. Social savings runs on peer accountability and the UI should make it visible. Note the existing `.ps .circle` rotating payout ring is the best component in the codebase — build around it, do not replace it.

### D19 — Brand unification (R10)

Four identities today: slate auth → green app → **purple** join → gray admin. The join page matters most; it is the viral surface, and a user's first impression of PawaSave is currently purple.

Bring `join/[groupId]` and `auth-screen` onto `.ps`. Resolve the three-way green disagreement (`--green` `#0A6B42`, `viewport.themeColor` `#059669`, `brand` `#10B981`) to one value, and delete the unused `pawa` palette from `tailwind.config.js`. Remove the vendor line from the auth footer. Reconcile "FlintAPI" / "Flipeet" / "selected automatically" in user-facing copy.

Document that `/protocol` and `/admin` keep `.proto-*` deliberately (R10.5), so it reads as intentional.

### D20 — Platform integration (R14)

The PWA foundation is already good — well-formed manifest with a maskable icon, and a service worker that is correctly conservative about never caching `/api`. Preserve that posture (R14.7). These are the gaps:

- **Haptics.** One utility, five call sites: `vibrate(10)` on tab change and sheet open, `(20)` on money-movement success, `([10,40,10])` on failure. Disproportionate perceived-quality gain on Android for near-zero cost.
- **Manifest.** Add `screenshots` (bare install prompt today) and `shortcuts` for Send and Receive (needs D7 routing). Reconcile `theme_color` `#0A6B42` with `viewport.themeColor` `#059669`.
- **Install prompt.** Custom in-app affordance; the browser default is easy to miss.
- **Pull to refresh** on primary scrollable screens (R7.9).
- **Self-host equity logos.** `stock-chart.tsx:133` requests `logo.clearbit.com` per symbol, so Clearbit learns which equities each user browses. Proxy or self-host.

---

## 7. What could go wrong

Ordered by how much damage it would do.

**D0 changes every heading at once.** Real Inter makes weights 650 and 680 resolve as distinct for the first time. Combined with D2 dropping body to 400, the app will look meaningfully different on first run. This is correct but will feel alarming. Review D0, D1 and D2 together on device in one sitting, and do not let anyone see D0 alone and conclude the fix broke the design.

**The `home-view` port is 1,048 lines and touches the money path.** It is a pure styling port, but it is large. Six separate commits, one per sub-screen, each verified in both themes. Do not fold the flow restructure (D13) or the fee fix (D12) into it — those are Phase 3 for exactly this reason.

**Routing moves the gating cascade.** The KYC → PIN → content interception at `app-shell.tsx:88-105` currently wraps everything by virtue of being in one component. Moved to a layout it must still intercept every route including deep links. Test direct navigation to `/app/send` as a user with no PIN, and as one with unverified KYC.

**The 11px floor changes layout.** Raising 9px and 10.5px text shifts row and nav heights. Re-check `.ps .b`'s 96px bottom padding against the new nav height, or content will hide behind it.

**The palette change silently invalidates contrast on two cards.** Swapping a gradient for a solid changes the effective background behind every element on `.acct` and `.pool`, including the translucent chrome that currently relies on a gradient sitting behind it. The `--on-hero-*` values in D21 are a starting point and must be measured, not trusted. This compounds with D0 and D2, so the Phase 1 device review covers all of it at once.

**Introducing a `--card` token would hide `UX-04` rather than fix it.** `groups-view.tsx:246` references undefined `var(--card, #12140f)`. Defining that name makes the reference resolve, to the wrong thing, and stop looking broken. D21 uses `--hero` for this reason, and D5 fixes the reference explicitly. Do not rename.

**Phosphor's bundle and small-size legibility are unverified.** Both are settled in the first icon task, before 66 call sites are migrated. If 16px `regular` is too light on a low-density device, the answer is `bold` at small sizes, not reverting the library.

**Server quotes touch a live money path.** D12 is the only API change here. It needs whoever owns `/api/ramp` in the loop, and the failure mode must be "block with explanation", never "fall back to a local estimate".

**Contrast fixes are unverified.** `UX-02`, `UX-04` and `UX-05` were found by reading the cascade. None has been seen on a screen. Device sign-off in both themes is mandatory (R3.8), and the same rigour applies to confirming they are fixed.

---

## 8. Verification

| Requirement | How it is proven |
|---|---|
| R1 | Computed `font-family` inside `.ps` reads `__Inter_f367f3` in devtools. Not inferred from source |
| R2 | Grep the stylesheet: no raw px for the six scaled dimensions outside the token block |
| R3 | Every screen photographed in light and dark on a real device. Contrast measured, not estimated |
| R4 | Automated a11y pass in CI, plus manual keyboard-only traversal and one screen-reader pass of the Send flow |
| R5 | Manual back-button traversal on an Android device, including mid-flow. Deep link to every route |
| R6 | Every error path triggered deliberately. Confirm no raw provider text and no auto-dismissing errors |
| R7 | Throttled network profile. Confirm no layout shift and no blank screens |
| R8 | End-to-end transfer on staging. Confirm displayed total equals charged amount |
| R9 | Keyboard-only open, traverse, Escape, and confirm focus returns to the invoker |
| R10 | Walk invite link → auth → app and confirm one typeface and one palette |
| R11 | Same balance compared across all tabs |
| R12 | Fresh account walked through first session |
| R13 | Grep each removed symbol, plus clean build and typecheck |
| R14 | Install on Android and iOS. Confirm shortcuts, prompt, haptics, theme colour |
| R15 | Grep for `gradient` returns nothing in consumer chrome. Contrast re-measured on every affected surface in both themes |
| R16 | Grep for `<svg viewBox` returns nothing in the consumer app. Bundle measured before and after. Smallest icon size checked on a real device |

Two standing rules, both carried from the Week 1 spec.

**Device verification, not inspection.** Code inspection found the Critical theme bugs. It cannot confirm they are fixed.

**Confirm D0 at runtime before building on it.** It is the load-bearing assumption of the whole spec. Five seconds in devtools gates a week of downstream work.
