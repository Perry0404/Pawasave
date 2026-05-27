## Off-Ramp Flow Implementation Guide

### Summary of Changes
Updated Flipeet off-ramp flow to match Flipeet API specification: **initialize → get address → send USDC from master wallet → webhook credit**.

### Changes Made

#### 1. **Migration 021: Deposit Address Tracking** (`supabase/migrations/021_deposit_address_tracking.sql`)
Tracks off-ramp deposit addresses from providers for audit trail and debugging.

**What it does:**
- Adds `provider_deposit_address` and `provider_custody_tx_id` columns to `transactions` table
- Creates audit view `offramp_audit` for admins to monitor withdrawals
- Adds RPC `set_transaction_deposit_address()` to record deposit address and custody tx ID

**When to run:** After migrations 017-020

#### 2. **Updated `ramp/route.ts` - Flipeet Off-Ramp Handler**
Enhanced `runFlipeet()` function with proper deposit address extraction and logging.

**Key improvements:**
- **Validates deposit address presence**: Throws error if Flipeet doesn't return an address
- **Logs address for audit**: Calls `set_transaction_deposit_address()` immediately after initialization
- **Stores custody TX ID**: Records Xend transaction ID for full audit trail
- **Explicit error handling**: Clear messages if XEND not configured or address missing

**Before (incorrect flow):**
```
User calls off-ramp → Pre-debit USDC → Try to send to Flipeet → Hope for address → Webhook credits
```

**After (correct flow per Flipeet):**
```
User calls off-ramp → Initialize off-ramp at Flipeet → Get deposit address → 
Store address in transaction → Send USDC from master via Xend → Webhook receives deposit → Credit user
```

### How the Flow Works

1. **User Initiates Off-Ramp:**
   - Frontend calls `/api/ramp` with `type: 'off'`, amount, bank details
   - Backend pre-debits user's USDC from wallet

2. **Initialize Flipeet Off-Ramp:**
   - Backend calls `initializeFlipeetOffRamp()` → Flipeet returns unique deposit address
   - Backend validates address is present, throws error if missing
   - Address stored in transaction record via `set_transaction_deposit_address()`

3. **Send USDC to Flipeet:**
   - Backend calls `merchantWalletWithdraw()` (Xend API) to send USDC from master wallet
   - Xend transaction ID stored in database for audit trail
   - If Xend fails → Refund user immediately, mark transaction failed

4. **Webhook Completion:**
   - Flipeet detects USDC at deposit address
   - Flipeet sends webhook → `/api/flipeet-webhook`
   - Webhook marks transaction as `completed` and updates paychant_tx_id
   - **For withdrawals: No additional credit needed** (already debited from user balance)
   - User can see completed withdrawal in transaction history

### Database Changes

**New columns in `transactions`:**
- `provider_deposit_address`: Where funds were sent (audit trail)
- `provider_custody_tx_id`: Xend/custody tx ID (links to USDC transfer)

**New RPC:**
- `set_transaction_deposit_address(p_reference, p_deposit_address, p_custody_tx_id)` — Updates transaction audit fields

**New view:**
- `offramp_audit` — Admin view of all withdrawals with deposit addresses for monitoring

### Deployment Checklist

- [ ] **Step 1:** Run migration 021 in Supabase SQL editor (after running 017-020)
  ```sql
  -- Run the SQL from supabase/migrations/021_deposit_address_tracking.sql
  ```

- [ ] **Step 2:** Test off-ramp with small amount in staging
  - User initiates withdrawal
  - Check logs for deposit address logged
  - Verify Xend receives USDC send request
  - Confirm Flipeet webhook fires
  - Verify transaction marked `completed`

- [ ] **Step 3:** Verify Flipeet webhook payload structure
  - Log full response in webhook to ensure `data.deposit?.address` matches
  - If Flipeet uses different path, update `readString()` call in webhook

- [ ] **Step 4:** Verify Xend integration
  - `merchantWalletWithdraw()` successfully sends USDC to arbitrary address
  - Returns transaction_id for audit trail
  - Handles rate limits and failures gracefully

### Troubleshooting

**Error: "Flipeet provider did not return deposit address"**
- Check Flipeet API response structure
- Verify `result.deposit?.address` exists
- Update webhook logging to capture full Flipeet payload

**Error: "Payment provider not configured"**
- Verify `XEND_CONFIGURED` environment variable
- Check Xend API credentials in env

**USDC sent but Flipeet webhook never fired**
- Verify callback URL in initialization matches `/api/flipeet-webhook`
- Check Flipeet webhook retry settings
- Manually trigger webhook via Flipeet dashboard for testing

**Xend withdrawal fails with specific error**
- Check Xend network/token configuration (should be USDC on Base)
- Verify master wallet has sufficient balance
- Check if address is valid (on correct network)

### Audit Trail
Admins can now view complete off-ramp flow:
```sql
SELECT * FROM public.offramp_audit WHERE created_at > NOW() - INTERVAL '24 hours';
```

Shows: `reference, deposit_address, custody_tx_id, status` for all withdrawals.

### Next Steps (Future)
- [ ] Add UI to show users where their funds are being sent (deposit address in receipt)
- [ ] Add webhook retry dashboard for admin monitoring
- [ ] Support other off-ramp providers (Flint, Xend) with same pattern
