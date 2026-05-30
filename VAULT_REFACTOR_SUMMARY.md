## Vault & Off-Ramp Refactor Summary (Commit 5c38ab0)

### Key Changes

#### 1. **Flipeet Off-Ramp Flow Fixed** (No Address Extraction)
- **Previous**: Tried to extract a single off-ramp address from Flipeet API response and send USDC to it
- **Now**: Flipeet generates a dynamic deposit address per transaction internally; we just initialize and wait for webhook
- **Why**: Flipeet's API doesn't return a single off-ramp address; they handle address generation on their side
- **Code**: `frontend/src/app/api/ramp/route.ts` lines 537-545 (simplified)

#### 2. **Removed Flexible Savings UI**
- All deposits now automatically go to **Flexible Savings (27% APY)** behind the scenes
- Users no longer see/choose "Flexible Savings" as a separate plan
- Removed entire flexible savings form, save/withdraw toggle, and related code
- **Benefit**: Simpler UX; no confusion about which type to pick

#### 3. **Implemented Tiered APY for Locked Savings**
- Duration-based APY tiers in `LOCK_DURATIONS`:
  - 90 days: **30% APY**
  - 180 days (6 months): **49.7% APY**
  - 365 days (1 year): **50% APY**
- UI now displays both duration and APY rate when selecting lock period
- Projected interest calculation uses selected duration's APY
- **File**: `frontend/src/components/vault-view.tsx`
- **Migration**: `supabase/migrations/022_fixed_savings_apy_tiers.sql` (not yet run)

#### 4. **Migration 022: Fixed Savings APY Tiers**
Tables & RPCs:
- `fixed_savings_apy_tiers` table: stores duration_days → apy_percent mapping
- `get_fixed_savings_apy(duration_days)` RPC: returns APY for given duration
- `calculate_goal_interest(principal, duration, days_elapsed)` RPC: calculates interest amount
- `goals.apy_percent_at_creation` column: audits the APY rate when goal created

**Status**: Created but NOT YET RUN. User must run in Supabase SQL editor.

---

### Deployment Checklist

- [ ] **Step 1**: Run migration 022 in Supabase SQL editor
  ```sql
  -- Copy content from supabase/migrations/022_fixed_savings_apy_tiers.sql
  ```

- [ ] **Step 2**: Verify Flipeet webhook still fires for off-ramps
  - Test a small withdrawal
  - Confirm webhook payload is received and processed
  - Verify transaction marked `completed` after Flipeet credits

- [ ] **Step 3**: Test locked savings with all three durations
  - Lock ₦1000 for 90 days → should show 30% APY
  - Lock ₦1000 for 180 days → should show 49.7% APY
  - Lock ₦1000 for 365 days → should show 50% APY
  - Verify projected interest calculations are correct

- [ ] **Step 4**: Verify flexible savings auto-allocation
  - Deposits should automatically go to 27% APY pool
  - No manual selection needed
  - Users should only see "Locked Savings" plan option (for higher returns)

---

### Files Changed

1. **frontend/src/app/api/ramp/route.ts**
   - Simplified Flipeet off-ramp: removed address extraction, XEND withdrawal, and deposit address logging
   - Now just initializes and waits for webhook

2. **frontend/src/components/vault-view.tsx**
   - Removed "Flexible Savings" plan from chooser
   - Added APY to duration buttons
   - Updated projected interest to use tiered APY
   - Removed save/withdraw toggle and flexible form

3. **supabase/migrations/022_fixed_savings_apy_tiers.sql** (NEW)
   - APY tier tables and RPCs

---

### Revenue Accrual (Next Phase)
- Flexible: Users get 27%, Xend pays 30-31%, platform keeps spread
- Fixed (X Auto): Users get 30-50% (duration-based), Xend pays 56-57%, platform keeps spread
- **Action**: Implement revenue tracking via `record_platform_fee()` RPC with yield spread calculations

---

### Frontend UX Changes

**Before:**
1. User taps Savings
2. Chooses "Flexible" or "Fixed"
3. If Flexible: can save/withdraw anytime at 33% APY
4. If Fixed: chooses 30-365 day lock at 50% APY

**After:**
1. User taps Savings
2. Only sees "Locked Savings" option (with tier breakdown: 30%/49.7%/50%)
3. Flexible auto-happens with all deposits (27% APY, no UI choice)
4. User can lock additional funds for higher rates

---

### Notes

- `Zap` icon was removed (was for flexible savings)
- `FlexAction` type no longer used but still in code (cleanup optional)
- `executeFlexible` function no longer called but still present (cleanup optional)
- Vault card now says "Savings Vault" instead of "cNGN Yield Vault"

Clean these up in future pass if desired.
