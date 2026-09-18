# Code style

## Comments

Write comments the way you would explain the line to a colleague sitting next to you. Short, plain, and only where the code cannot speak for itself.

**Keep**
- Why a non-obvious decision was made
- A constraint that is not visible locally, such as a provider quirk or an ordering requirement
- A warning where the obvious change would be wrong

**Drop**
- Restating what the code already says
- Long narrative histories of past bugs
- Decorative separators and banner blocks
- Audit or ticket IDs inline, unless the comment would be meaningless without one

## Punctuation

No em dashes. Use a comma, a full stop, or a new sentence.

Avoid parenthetical stacking. If a sentence needs two asides to make sense, it needs to be two sentences.

## Length

One or two lines is the norm. If a comment runs past four lines, either the code needs restructuring or the explanation belongs in the spec or a design doc.

File headers are for orientation, not documentation. Say what the file is for in a sentence or two and stop.

## Examples

Too much:

```ts
/**
 * ensureFreeCngn — guarantees custody holds enough FREE cNGN before a buy.
 *
 * The problem this solves: the reconcile cron sweeps idle custody cNGN into
 * PawasaveLend for yield (see cron/strails-reconcile), so custody's free balance
 * is usually ~0 and the working cNGN lives as psNGN shares in the pool. We must
 * therefore redeem just enough (plus a 1% rounding buffer, capped at what custody
 * actually holds) back to custody so that the HyperFX escrow can pull it. This
 * was previously failing because we always redeemed shares sized to the FULL
 * payout rather than the shortfall (V2-MED-05).
 */
```

Enough:

```ts
/**
 * Redeem enough cNGN from the pool to cover a buy.
 * Custody usually holds close to zero because the reconcile cron sweeps idle
 * balance into the pool for yield.
 */
```

Too much:

```ts
// Manage nonces EXPLICITLY across these back-to-back custody txs: the shared
// custody wallet + RPC nonce lag handed two txs the same nonce → "replacement
// transaction underpriced". Fetch the pending nonce once and increment per tx.
```

Enough:

```ts
// One custody wallet signs several txs here, so track the nonce locally.
// Letting the RPC assign it hands out duplicates under load.
```

## SQL

Same rules. Migrations carry a short header saying what changes and why, then the statements.

State any manual step or ordering dependency plainly at the top, since migrations in this project are applied by hand.

## Naming

Prefer a clear name over a comment explaining a vague one. `hardWithdrawalCeiling` needs no comment; `maxAmt2` does.

## Scope

This covers code and SQL. Specs, design docs and audit reports are prose and follow their own conventions.

## Voice

Write like you're explaining it to the teammate next to you. Plain, short, human. Never robotic.

The test: read the comment aloud. If it sounds like a changelog entry or a compliance document, rewrite it.

Not this:

```ts
// This function is responsible for the retrieval and subsequent validation of
// the user's authentication token prior to the execution of the request.
```

This:

```ts
// Grab the token and check it before we do anything expensive.
```

Same rule for commit messages, PR descriptions and migration headers. Detailed enough to be useful, short enough to read in one pass.

## Commit messages

One commit per completed task or phase. Never batch unrelated work. If a commit would leave the app broken on its own, it isn't a commit boundary.

Follow the convention already in this repo: `type(scope): subject`, all lowercase.

Types in use: `fix`, `feat`, `chore`, `docs`, `refactor`, `security`, `infra`.
Scopes are domain names, not file paths: `ramp`, `custody`, `invest`, `auth`, `kyc`, `ajo`, `strails`, `hyperfx`, `admin`, `ops`, `ui`, `theme`, `brand`, `a11y`.

Subject line: under ~70 characters, imperative mood, no trailing full stop. Say what changed, not what file changed. A comma or a dash to carry the "why" is fine and common here.

Body: two to five short lines. What changed, and why it mattered. Skip it only when the subject genuinely says everything.

Reference the spec task when there is one, on its own line at the end.

Enough:

```
fix(ui): load Inter properly, the app was falling back to system font

next/font never registers the literal family "Inter", so `.ps` asked for a
font that didn't exist and every screen rendered in Roboto or SF. Weights
650/680 were snapping to 700, which is what flattened the hierarchy.

Spec: frontend-ux-elevation task 1
```

Too much:

```
fix(fonts): resolve font-family resolution failure in .ps scope

This commit addresses the issue whereby the next/font/google loader does not
register a global @font-face declaration under the literal family name...
(continues for twelve more lines)
```

Too little:

```
fix font
```

Note `.kiro/` is gitignored, so specs and steering never appear in a commit. Reference the spec task in the body instead.
