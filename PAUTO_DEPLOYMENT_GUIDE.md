# P-AUTO Vault - Smart Contract Deployment Guide

## Overview
P-AUTO is PawaSave's proprietary yield aggregation vault contract that replaces the Xend X-AUTO dependency. It provides:
- **27% APY** on flexible deposits (via Money Market optimization)
- **49.7% APY** on fixed deposits (30/90/180/365 days)
- **Automatic yield harvesting** with 6% platform fee
- **Lock period enforcement** for fixed deposits
- **Multi-strategy support** with rebalancing

---

## Contract Architecture

### Key Features

1. **Deposit Types**
   - **Flexible**: No lock, withdraw anytime, earn 27% APY
   - **Fixed 30d**: Locked 30 days, earn 4.14% over period
   - **Fixed 90d**: Locked 90 days, earn 12.41% over period
   - **Fixed 180d**: Locked 180 days, earn 24.82% over period
   - **Fixed 365d**: Locked 1 year, earn 49.7% over period

2. **Fee Structure**
   - **Platform Fee**: 6% (600 bps) on harvested yield
   - **Lock Penalty**: 0.5% on early withdrawal (forfeits all interest)

3. **Strategy Routing**
   - Primary: High-yield strategy (Xend Money Market, etc.)
   - Fallback: Stable strategy (conservative yield)
   - Auto-rebalance every 7 days

---

## Deployment Steps

### 1. Contract Compilation
```bash
# Using Hardhat or Foundry
npx hardhat compile

# Or with Foundry
forge build
```

### 2. Deployment on Base (Testnet/Mainnet)

```solidity
// Deploy script example
const PawasaveAutoVault = await ethers.getContractFactory("PawasaveAutoVault");
const vault = await PawasaveAutoVault.deploy(
  "0xCNGN_TOKEN_ADDRESS",           // cNGN token
  "0xXEND_MONEY_MARKET_ADDRESS",    // Primary strategy
  "0xSTABLE_STRATEGY_ADDRESS",      // Fallback strategy
  "0xFEE_RECIPIENT_ADDRESS"         // Platform fee destination
);

await vault.deployed();
console.log("P-AUTO deployed to:", vault.address);
```

### 3. Setup

**Grant Harvester Role**
```solidity
await vault.grantHarvesterRole("0xKEEPER_ADDRESS");
```

**Set Rebalance Interval**
```solidity
// Already set to 7 days in constructor, can be modified
```

---

## Database Migration for P-AUTO Integration

Run this migration to track P-AUTO vault interactions:

```sql
-- 024_pauto_vault_integration.sql
-- Track P-AUTO vault interactions and lock periods

CREATE TABLE IF NOT EXISTS public.pauto_deposits (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  deposit_type TEXT NOT NULL CHECK (deposit_type IN ('flexible', 'fixed_30', 'fixed_90', 'fixed_180', 'fixed_365')),
  amount_usdc_micro BIGINT NOT NULL,
  amount_kobo BIGINT NOT NULL,
  unlock_time TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  withdrawn_at TIMESTAMP,
  contract_tx_hash TEXT
);

-- View for active P-AUTO locks
CREATE OR REPLACE VIEW public.pauto_active_locks AS
  SELECT
    user_id,
    COUNT(*) as active_count,
    SUM(amount_usdc_micro) as total_locked_usdc_micro,
    ROUND(SUM(amount_usdc_micro) / 1000000.0, 2) as total_locked_usdc,
    MIN(unlock_time) as next_unlock_time
  FROM public.pauto_deposits
  WHERE withdrawn_at IS NULL
    AND (unlock_time IS NULL OR unlock_time > NOW())
  GROUP BY user_id;

-- Index for faster queries
CREATE INDEX IF NOT EXISTS idx_pauto_user_active ON public.pauto_deposits(user_id, withdrawn_at, unlock_time);
CREATE INDEX IF NOT EXISTS idx_pauto_unlock_time ON public.pauto_deposits(unlock_time);
```

---

## Backend Integration with P-AUTO

### 1. Update Deposit Route

**File**: `frontend/src/app/api/ramp/route.ts`

```typescript
import { interactWithPAutoVault } from '@/lib/pauto-vault'

// In deposit handler:
async function depositToPAutoVault(
  userAddress: string,
  amountUsdc: bigint,
  depositType: 'flexible' | 'fixed_30' | 'fixed_90' | 'fixed_180' | 'fixed_365'
) {
  // Get user's wallet address or create one
  const userWallet = await getOrCreateUserWallet(userAddress)
  
  // Call P-AUTO deposit via contract
  const tx = await interactWithPAutoVault.deposit(
    userWallet.address,
    amountUsdc,
    depositType
  )
  
  // Track in database
  await supabase.from('pauto_deposits').insert({
    user_id: userAddress,
    deposit_type: depositType,
    amount_usdc_micro: amountUsdc,
    contract_tx_hash: tx.hash
  })
  
  return { txHash: tx.hash, shares: tx.shares }
}
```

### 2. Create P-AUTO Library

**File**: `frontend/src/lib/pauto-vault.ts`

```typescript
import { ethers } from 'ethers'
import P_AUTO_ABI from '@/contracts/abi/PawasaveAutoVault.json'

const PAUTO_ADDRESS = process.env.NEXT_PUBLIC_PAUTO_VAULT_ADDRESS!
const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL!

const provider = new ethers.JsonRpcProvider(RPC_URL)
const contract = new ethers.Contract(PAUTO_ADDRESS, P_AUTO_ABI, provider)

export async function depositFlexible(
  userAddress: string,
  amountUsdc: bigint
) {
  const signer = await getSignerForUser(userAddress)
  const contractWithSigner = contract.connect(signer)
  
  const tx = await contractWithSigner.depositFlexible(amountUsdc, userAddress)
  const receipt = await tx.wait()
  
  return {
    hash: tx.hash,
    blockNumber: receipt.blockNumber,
    shares: receipt.logs[0].args.shares // Parse from event
  }
}

export async function depositFixed(
  userAddress: string,
  amountUsdc: bigint,
  lockDays: 30 | 90 | 180 | 365
) {
  const signer = await getSignerForUser(userAddress)
  const contractWithSigner = contract.connect(signer)
  
  const tx = await contractWithSigner.depositFixed(
    amountUsdc,
    userAddress,
    lockDays
  )
  const receipt = await tx.wait()
  
  return {
    hash: tx.hash,
    blockNumber: receipt.blockNumber,
    unlockTime: receipt.logs[0].args.unlockTime
  }
}

export async function checkActiveLocks(userAddress: string): Promise<boolean> {
  return contract.hasActiveLock(userAddress)
}

export async function getNextUnlockTime(userAddress: string): Promise<number> {
  return contract.getNextUnlockTime(userAddress)
}

export async function getUserYieldAccrued(userAddress: string): Promise<bigint> {
  // Calculate based on shares and total yield
  const userShares = await contract.balanceOf(userAddress)
  const totalAssets = await contract.totalAssets()
  const totalShares = await contract.totalSupply()
  
  return (userShares * totalAssets) / totalShares
}

export async function withdrawFlexible(
  userAddress: string,
  shares: bigint
) {
  const signer = await getSignerForUser(userAddress)
  const contractWithSigner = contract.connect(signer)
  
  const tx = await contractWithSigner.withdraw(shares, userAddress, userAddress)
  const receipt = await tx.wait()
  
  return { hash: tx.hash, assetsReceived: receipt.logs[0].args.assets }
}
```

### 3. Update Consent Flow

**File**: `frontend/src/hooks/use-data.ts`

```typescript
export async function createPAutoLock(
  amountUsdc: number,
  kobo: number,
  durationDays: number,
  apy: number,
  userConsentAccepted: boolean = true
) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Call old RPC for database tracking
  const { data, error: rpcError } = await supabase.rpc('lock_savings', {
    p_user_id: user.id,
    p_usdc_micro: amountUsdc,
    p_kobo: kobo,
    p_duration_days: durationDays,
    p_apy: apy,
    p_user_consent_accepted: userConsentAccepted,
  })
  if (rpcError) throw rpcError

  // Also track in P-AUTO deposits table
  const depositType = getDe depositType(durationDays)
  await supabase.from('pauto_deposits').insert({
    user_id: user.id,
    deposit_type: depositType,
    amount_usdc_micro: amountUsdc,
    amount_kobo: kobo,
    unlock_time: durationDays > 0 
      ? new Date(Date.now() + durationDays * 86400000).toISOString()
      : null,
  })

  return data
}

function getDepositType(days: number): string {
  if (days === 30) return 'fixed_30'
  if (days === 90) return 'fixed_90'
  if (days === 180) return 'fixed_180'
  if (days === 365) return 'fixed_365'
  return 'flexible'
}
```

---

## Environment Variables

Add to `.env.local`:

```env
# P-AUTO Vault
NEXT_PUBLIC_PAUTO_VAULT_ADDRESS=0x...            # Deployed vault address on Base
NEXT_PUBLIC_BASE_RPC_URL=https://mainnet.base.org
PAUTO_PRIVATE_KEY=0x...                         # For backend vault operations
PAUTO_HARVESTER_ADDRESS=0x...                   # Keeper/harvester account
```

---

## Frontend Updates

### 1. Update Vault Component

All vault UI already supports the new structure - just need to:
- Point to P-AUTO addresses instead of Xend
- Update yield calculation to use contract views
- Display lock times from contract

### 2. Update Goals Component

- Lock enforcement already in place
- Yield tracking will pull from P-AUTO

### 3. Update Admin Dashboard

Add P-AUTO stats:

```typescript
// In admin/revenue/page.tsx
const pautoMetrics = await fetch('/api/pauto-metrics').then(r => r.json())

// Display: Active locks, users in vault, total TVL, daily yield
```

---

## Yield Harvesting Strategy

### Automated Harvest (via Keeper)

```typescript
// Run every 24 hours via Vercel Cron
export async function harvestPAutoYield() {
  const vault = new ethers.Contract(PAUTO_ADDRESS, ABI, harvesterSigner)
  
  const tx = await vault.harvestYield()
  await tx.wait()
  
  // Log to database for tracking
  await supabase.from('yield_harvest_log').insert({
    contract_address: PAUTO_ADDRESS,
    tx_hash: tx.hash,
    timestamp: new Date(),
  })
}
```

### Rebalancing Strategy

```typescript
// Run weekly
export async function rebalancePAuto() {
  const vault = new ethers.Contract(PAUTO_ADDRESS, ABI, ownerSigner)
  
  const canRebalance = await vault.lastRebalanceTime()
    .then(t => Date.now() - t * 1000 >= 7 * 86400000)
  
  if (canRebalance) {
    const tx = await vault.rebalance()
    await tx.wait()
  }
}
```

---

## Testing Checklist

- [ ] Deploy contract on Base Sepolia testnet
- [ ] Test depositFlexible() with small amounts
- [ ] Test depositFixed() with all lock periods
- [ ] Test lock enforcement (try early withdraw)
- [ ] Test harvestYield() and fee calculation
- [ ] Test rebalancing logic
- [ ] Verify shares calculation
- [ ] Test emergency pause/unpause
- [ ] Load test with multiple users
- [ ] Audit contract code
- [ ] Deploy to Base mainnet

---

## Safety & Security

1. **Consent Tracking**: All deposits have user_consent_accepted flag
2. **Lock Enforcement**: Contracts revert on early withdrawal
3. **Fee Limits**: Platform fee capped at 15% (hardcoded check)
4. **Pause Mechanism**: Emergency stop available to owner
5. **Reentrancy Guards**: All external calls protected with nonReentrant
6. **Rate Limiting**: Rebalance only once per 7 days

---

## Migration Timeline

**Phase 1**: Deploy P-AUTO on testnet, test thoroughly
**Phase 2**: Deploy on mainnet with zero TVL, test with small deposits
**Phase 3**: Migrate users gradually with UI prompts
**Phase 4**: Deprecate Xend dependency, full P-AUTO production

---

## Support

For questions or issues:
- Check contract events for TX debugging
- Review yieldharvest logs
- Verify user consent in `savings_locks.user_consent_accepted`
- Monitor `pauto_active_locks` view for lock status
