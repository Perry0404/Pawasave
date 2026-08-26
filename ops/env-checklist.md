# PawaSave env checklist — Vercel → self-hosted (Coolify)

Grounded in the actual `vercel env pull` of production (2026-08-22). Set every var
below in Coolify. **NEXT_PUBLIC_\*** must be marked **Build Variable** (they're inlined
into the client bundle at build time); everything else is runtime-only.

---

## 1. Import wholesale from `.env.recovery` (already have the values)
These pulled with values — copy straight across. **Drop the platform-injected junk**
(`VERCEL`, `VERCEL_ENV`, `VERCEL_OIDC_TOKEN`, `VERCEL_TARGET_ENV`, `NX_DAEMON`,
`TURBO_*`) — those are Vercel/build-tool noise, not app config.

Real config in the pull:
- Core: `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `CRON_SECRET`, `ADMIN_PASSWORD`
- RPC (your paid endpoints — keep them): `BASE_MAINNET_RPC_URL`, `BASE_WRITE_RPC_URL`
- Contract addresses: `PAWASAVE_LEND_ADDRESS`, `PRICE_ORACLE_ADDRESS`, `PAUTO_VAULT_ADDRESS`, `CREDIT_LINE_ADDRESS`, `NEXT_PUBLIC_LEND_ADDRESS`, `NEXT_PUBLIC_ORACLE_ADDRESS`, `NEXT_PUBLIC_PAUTO_VAULT_ADDRESS`
- Strails: `STRAILS_ENABLED`, `STRAILS_BASE_URL`, `STRAILS_API_KEY`, `STRAILS_RELAY_SECRET`, `STRAILS_WEBHOOK_SECRET`, `STRAILS_AES_KEY`
- Flint: `FLINT_ENABLED`, `FLINT_API_KEY`, `FLINT_WEBHOOK_SECRET`; `FLIPEET_WEBHOOK_TOKEN`
- Mail: `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT`, `SMTP_FROM`
- Push: `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
- Misc present: `NEXT_PUBLIC_PAYCHANT_API_KEY`, `NEXT_PUBLIC_PAYCHANT_ENV`, `XEND_LIVE_PRIVATE_KEY`

## 2. Add manually — the 4 wallet keys you already hold (runtime secrets)
`CUSTODY_PRIVATE_KEY`, `DEPLOYER_PRIVATE_KEY`, `ORACLE_KEEPER_PRIVATE_KEY`, `VAULT_HARVESTER_PRIVATE_KEY`

## 3. Add manually — recover safely first
`DEPOSIT_MNEMONIC_KEY` — the one missing secret. Recover via the encrypt-and-export
step (never printed in plaintext), back it up, then set it here.

## 4. Re-fetch from the provider dashboard (were "Sensitive" → empty on pull)
- Flipeet: `FLIPEET_API_KEY`, `FLIPEET_CUSTODY_ADDRESS`
- Xend: `XEND_API_KEY`, `XEND_PRIVATE_KEY`, `XEND_MERCHANT_ID`, `XEND_CUSTODY_ADDRESS`
  ⚠️ Code reads `XEND_PRIVATE_KEY` but prod only had `XEND_LIVE_PRIVATE_KEY` set — reconcile the name or Xend stays off.
- Sense (KYC): `USESENSE_API_KEY`, `USESENSE_WEBHOOK_SECRET` (+ `USESENSE_BASE_URL`)

## 5. Public / derivable — set from code defaults or on-chain (were empty)
`NEXT_PUBLIC_BASE_RPC_URL`, `NEXT_PUBLIC_BASE_CHAIN_ID` (8453), `NEXT_PUBLIC_CNGN_ADDRESS`,
`NEXT_PUBLIC_CNGN_TOKEN_ADDRESS`, `NEXT_PUBLIC_USDC_ADDRESS`, `FEE_RECIPIENT_ADDRESS`,
`INSURANCE_FUND_ADDRESS`, `ORACLE_KEEPER_ADDRESS` (the address of the keeper key).
Not secret — from your records / BaseScan. Several have safe fallbacks in `contracts.ts`.

## 6. Rotate during the move (previously leaked in chat)
- `VAPID_PRIVATE_KEY` (+ regenerate the matching `NEXT_PUBLIC_VAPID_PUBLIC_KEY`) — note: existing push subscriptions re-subscribe.
- `SMTP_PASS` — issue a fresh Zoho app password; revoke the old one.

## 7. Optional / feature-flagged (set only if you use them)
Ramp tuning (`NGN_USD_RATE`, `LITE_KYC_CAP_NGN`, `BVN_DAILY_CAP_NGN`, `PAWA_DEPOSIT_FEE_PERCENT`,
`RAMP_*`), sweep tuning (`DEPOSIT_SWEEP_*`, `CUSTODY_POOL_BUFFER_MICRO`, `*_RECONCILE_MINUTES`),
rate-limit (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`), USSD (`USSD_ENABLED`,
`USSD_GATEWAY_SECRET`), GetEquity (`GETEQUITY_*`), AWS Secrets Manager (`AWS_SECRETS_ID`, `AWS_REGION`).

## 8. Tokenized stocks (dark — flip on ONLY after Nigeria eligibility is confirmed)
Buys route on Base: `cNGN → USDC → <stock token>` from the custody wallet (reuses
`CUSTODY_PRIVATE_KEY`). Stays "coming soon" until BOTH the master switch and a non-empty
token map are set.
- `EQUITY_ENABLED=true` — master switch. Leave UNSET until Coinbase/Backed confirm Nigeria is an eligible jurisdiction (the issuer can freeze wallets in prohibited regions).
- `EQUITY_BROKER=base_dex` — the on-Base aggregator path.
- `STOCK_TOKEN_MAP` — JSON of **verified** symbol→token address, e.g.
  `{"AAPL":"0x…","NVDA":"0x…","META":"0x…","GOOGL":"0x…"}` (Coinbase's live B20 tokens:
  AAPLc/NVDAc/METAc/GOOGLc — paste the addresses from each asset's prospectus/BaseScan, never guess).
  Optional per-symbol decimals: `{"AAPL":{"address":"0x…","decimals":18}}` (else read on-chain).
- Optional: `EQUITY_SWAP_AGG=odos|0x` (default `odos`, needs no key), `ZEROX_API_KEY` (only if `0x`),
  `EQUITY_SLIPPAGE_BPS=100` (per-leg slippage guard, default 1%).
- Sanity before going live: confirm each stock token has real Aerodrome/DEX USDC liquidity (a
  route exists), and do ONE tiny real buy end-to-end before opening to testers.

## ⚠️ Finding: `BVN_HASH_SALT` was never set in production
The code hashes `bvn + (process.env.BVN_HASH_SALT || '')`, so with the var unset **BVN
hashes have been computed with an empty salt.** Migration impact: **none good** — there's
no secret to preserve; just **leave `BVN_HASH_SALT` unset** so existing hashes still match.
Security follow-up (separate from the move): an unsalted 11-digit BVN hash is brute-forceable;
adding a real pepper later means re-hashing, which needs the raw BVNs (not stored) — so treat
as a known limitation to design around, not a quick fix.
