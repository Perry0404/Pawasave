# PawaSave — Operations & Go-Live Guide

Everything needed to make **both** the consumer app and the lending protocol run,
plus the fix for the password-reset email problem.

---

## 1. Funding the operational wallets with gas (your "$13" question)

You have three operational wallets that sign on-chain transactions on **Base**.
They need **ETH on Base for gas** — not USDC, not cNGN.

| Wallet | Env var | What it does | Tx volume | Fund with |
|---|---|---|---|---|
| **Custody** | `CUSTODY_PRIVATE_KEY` (address = `FLIPEET_CUSTODY_ADDRESS`) | Sends cNGN to users on off-ramp; supplies/withdraws cNGN to PawasaveLend | High (every deposit/withdraw) | **0.05 ETH** |
| **Vault harvester** | `VAULT_HARVESTER_PRIVATE_KEY` | Calls `harvestYield()` once/day via cron | 1 tx/day | **0.01 ETH** |
| **Oracle keeper** | `ORACLE_KEEPER_PRIVATE_KEY` | Pushes the NGN/USD price to `PriceOracle` | ≤1 tx / 30 min (only on >0.5% move) | **0.01 ETH** |

**Recommendation: fund the exact role-based ETH amounts (0.05 / 0.01 / 0.01 ETH), not a flat $13 each.**

Why:
- Base gas is ~$0.001–0.01 per transaction, so even **0.01 ETH is thousands of transactions** — these amounts last a long time.
- The custody wallet signs by far the most transactions, so it gets the most headroom (0.05).
- A flat "$13 each" would over-fund the keeper/harvester and under-prioritise custody. The role split is cleaner.
- These are generous — you can start lower and top up. Set a reminder to refill custody when it drops below ~0.01 ETH.

> Total to bridge to Base: **~0.07 ETH** across the three wallets.

---

## 2. Environment variables required to "turn it on"

These are the vars that still need to be set in **Vercel → Project → Settings → Environment Variables**
(see [frontend/.env.local.example](frontend/.env.local.example) for the full list).

### Consumer app (ramp + savings)
```
CUSTODY_PRIVATE_KEY=0x...        # controls FLIPEET_CUSTODY_ADDRESS
FLIPEET_API_KEY=...
FLIPEET_CUSTODY_ADDRESS=0x...
FLIPEET_ASSET=cngn               # cNGN end-to-end (was usdc — now fixed in code)
SUPABASE_SERVICE_ROLE_KEY=...    # webhook + deposit crediting
FLINT_ENABLED=false              # Flint stays off until you opt in
XEND_ENABLED=false               # Xend stays off until you opt in
DEPOSIT_WALLET_MNEMONIC="..."    # master seed for per-user crypto deposit addresses (SECRET)
```

### Lending protocol + cron jobs
```
BASE_MAINNET_RPC_URL=https://mainnet.base.org
PAUTO_VAULT_ADDRESS=0x...        # or NEXT_PUBLIC_PAUTO_VAULT_ADDRESS (already set)
VAULT_HARVESTER_PRIVATE_KEY=0x...
PRICE_ORACLE_ADDRESS=0x...
ORACLE_KEEPER_PRIVATE_KEY=0x...
PAWASAVE_LEND_ADDRESS=0xA540FB9a23DDB7Cd989CDe0d924dd2a76533a9eA
USDC_TOKEN_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
CRON_SECRET=<random string>      # secures /api/cron/* — set the SAME value in Vercel Cron
```

### Cron jobs (already declared in [frontend/vercel.json](frontend/vercel.json))
| Endpoint | Schedule | Needs |
|---|---|---|
| `/api/cron/accrue-yield` | daily 00:00 | `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` |
| `/api/cron/auto-contribute` | daily 01:00 | `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` |
| `/api/cron/harvest-vault` | daily 02:00 | `BASE_MAINNET_RPC_URL`, `VAULT_HARVESTER_PRIVATE_KEY`, `PAUTO_VAULT_ADDRESS`, `CRON_SECRET` |
| `/api/cron/scan-deposits` | every 10 min* | `BASE_MAINNET_RPC_URL`, `DEPOSIT_WALLET_MNEMONIC`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` |

\* `*/10` cron granularity needs Vercel **Pro**. On the Hobby plan crons run daily — but the app also self-syncs each user's deposits when they open Home (`POST /api/wallet/sync-deposits`), so deposits still appear quickly regardless of the cron.

The **oracle keeper** is not a Vercel cron — run it on a schedule (PM2/cron) per
[scripts/oracle-keeper.ts](scripts/oracle-keeper.ts), or you can add it as a 4th Vercel cron.

---

## 3. Fixing the password-reset email (no link / link lands on the create-account page)

**90% of this is Supabase dashboard configuration, not code.** Two separate problems:

### A) No reset email arrives → set up custom SMTP
Supabase's built-in email is rate-limited to a few messages/hour and frequently
not delivered. Use your **Zoho** mailbox (you already verified the domain —
`frontend/public/zoho-domain-verification.html`).

Supabase Dashboard → **Authentication → Emails → SMTP Settings → Enable Custom SMTP**:
```
Host:        smtp.zoho.com
Port:        587   (TLS)   — or 465 (SSL)
Username:    noreply@pawasave.xyz        (a real Zoho mailbox)
Password:    <Zoho app-specific password>   (Zoho → Security → App Passwords)
Sender email: noreply@pawasave.xyz
Sender name: PawaSave
```

### B) Reset link redirects to the create-account page → fix the redirect allowlist
This is the key bug. When the `redirectTo` URL is **not** in Supabase's allowlist,
Supabase ignores it and falls back to the **Site URL** — which lands the user on
`/` (the sign-in / create-account screen) instead of `/reset-password`.

Supabase Dashboard → **Authentication → URL Configuration**:
```
Site URL:        https://pawasave.xyz

Redirect URLs (add all):
  https://pawasave.xyz/**
  https://pawasave.xyz/auth/callback
  https://pawasave.xyz/reset-password
  http://localhost:3000/**          (for local dev)
```

### Code side (already done in this change)
- `signUp` now sets `emailRedirectTo` → confirmation links route through `/auth/callback`.
- `/auth/callback` now surfaces Supabase `?error=` params and always sends recovery
  links to `/reset-password`.
- `/reset-password` now shows the specific error (e.g. "link expired") instead of a generic message.

After A + B, request a fresh reset email and open the **newest** link (old links expire).

---

## 4. Adding USDT / T-bills / RWAs as collateral

The lending contract already supports multiple collateral tokens with per-token LTV.
USDC (75%) and cNGN (60%) are live. To add more:

1. Set the token address(es) in the frontend env (Vercel):
   ```
   NEXT_PUBLIC_USDT_TOKEN_ADDRESS=0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2
   NEXT_PUBLIC_TBILL_TOKEN_ADDRESS=0x...   # when you have one
   NEXT_PUBLIC_RWA_TOKEN_ADDRESS=0x...     # when you have one
   ```
2. List them on-chain + set their oracle price (owner/keeper key):
   ```
   # USDT (uses NGN_PER_USD for price):
   PAWASAVE_LEND_ADDRESS=0x... PRICE_ORACLE_ADDRESS=0x... NGN_PER_USD=1650 \
     npx hardhat run scripts/add-collateral.ts --network baseMainnet

   # T-bills / RWA (price = cNGN value of 1 whole token):
   TBILL_TOKEN_ADDRESS=0x... TBILL_PRICE_CNGN=100000 TBILL_LTV=0.70 \
   RWA_TOKEN_ADDRESS=0x...   RWA_PRICE_CNGN=50000    RWA_LTV=0.65 \
     npx hardhat run scripts/add-collateral.ts --network baseMainnet
   ```

### What makes a collateral "live" (and the UI gating)
A token is usable only when **all three** are true:
1. **Frontend address** — `NEXT_PUBLIC_*_TOKEN_ADDRESS` set (so it appears in the selector).
2. **Listed on-chain** — `addCollateral(token, decimals, LTV)` done (via the script).
3. **Fresh oracle price** — a price exists and is < 1h old (or the contract reverts).

The borrow panel now reads each token's on-chain `collaterals()` status and shows
**"(coming soon)"** + disables Deposit for any token that isn't live yet — so users
never hit a confusing "Collateral not accepted" revert. Withdraw stays enabled.

The **oracle keeper now prices USDC *and* USDT automatically** (same USD peg). So
to make **USDT** fully live you only need to run `add-collateral.ts` once; the
keeper keeps it fresh thereafter.

### ⚠️ Do NOT self-issue fake T-bills/RWAs
An RWA token's value comes **entirely from the real assets backing it**, not the
contract. A token you mint yourself with no backing is worthless and dangerous as
collateral (you'd be lending real cNGN against printed money — instant insolvency
risk, and misleading to users). A *legitimate* PawaSave-issued RWA would require a
legal entity, a regulated custodian holding the real assets, audits/attestations,
KYC and securities compliance — a months-long project, not a code change.

### The real path: partner with an issuer (e.g. the cNGN team)
For genuine T-bill/RWA collateral, partner with an issuer who has already done the
legal + custody work, and have them:
1. **Allowlist the pool** `0xA540FB9a23DDB7Cd989CDe0d924dd2a76533a9eA` so it can
   hold the (usually permissioned) token — otherwise `depositCollateral` reverts.
2. Allowlist liquidators (or pre-agree a liquidation path) so unhealthy positions
   can still be closed.
3. Provide a **price/NAV feed** for the asset, which we wire into the keeper.

Once those are in place it's a 2-minute job: set the env address + run
`add-collateral.ts`.

> **Note on "funding the wallet" with USDT/RWA/T-bills:** the protocol uses these as
> *collateral to borrow cNGN*. They are **not** used to fund the consumer app — the
> in-app wallet is funded with **cNGN** (fiat on-ramp or crypto deposit, see §6).

---

## 5. cNGN-only ramp (Flint & Xend disabled)

PawaSave now uses **Flipeet only**, settling in **cNGN end-to-end**:

- On-ramp: Flipeet delivers cNGN to the custody wallet; the user is credited the
  naira value as cNGN (1 cNGN = ₦1) — no USD conversion.
- Off-ramp: custody sends cNGN to Flipeet's deposit address; the user's cNGN
  balance is debited 1:1.
- **Flint and Xend are off** unless you set `FLINT_ENABLED=true` / `XEND_ENABLED=true`.

Savings are **denominated in cNGN/naira — there is no USD anywhere** in the
consumer balance. The live Flipeet rate is only ever used for fiat pricing, never
to value a saved balance.

The Vault, Goals, Activity, Groups and Admin screens are now relabelled to
cNGN/₦ (the shared `format.ts` helpers render naira). If you have existing test
balances created under the old USD model, run the one-off re-denomination
migration **[027_redenominate_cngn.sql](supabase/migrations/027_redenominate_cngn.sql)**
(edit `v_rate` first; it's run-once and guarded), or just reset test data pre-launch.

---

## 6. Crypto deposits (fund the wallet with cNGN, no fiat)

A user can fund their wallet by sending **cNGN on Base** to their personal
address — it credits automatically, just like a fiat deposit.

**How it works**
1. Each wallet has a stable `deposit_index`. The app derives a real, unique Base
   address from `DEPOSIT_WALLET_MNEMONIC` at `m/44'/60'/0'/0/{index}` and shows it
   on Home (`GET /api/wallet/deposit-address`).
2. A scanner watches cNGN `Transfer` events to those addresses and credits the
   matching user (`credit_crypto_deposit`, idempotent by tx hash):
   - `POST /api/wallet/sync-deposits` — runs when the user opens Home (instant).
   - `GET /api/cron/scan-deposits` — cron sweep for everyone.

**Setup**
1. Run the migration **[026_crypto_deposits.sql](supabase/migrations/026_crypto_deposits.sql)** in Supabase.
   (This also clears the old placeholder `deposit_address` values, which were
   never real wallets.)
2. Set `DEPOSIT_WALLET_MNEMONIC` (a fresh BIP-39 seed you control) in Vercel.
3. Set `CRON_SECRET` and confirm the `scan-deposits` cron (or rely on the
   on-open self-sync).

⚠️ The old per-user address was a placeholder (`0x + sha256(user_id)`) with **no
private key** — funds sent there were unrecoverable. Migration 026 replaces it
with real HD addresses. Do not re-enable the old generator.
