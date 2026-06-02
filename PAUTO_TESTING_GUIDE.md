# P-AUTO Testing & Setup Guide

## Quick Start

### 1. Install Dependencies

```bash
cd ~/Pawasave
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox @typechain/ethers-v6 typechain
npm install ethers
```

### 2. Setup Environment

Create `.env.local` in project root:

```env
# Hardhat/Testing
FORKING=false
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BASE_MAINNET_RPC_URL=https://mainnet.base.org
DEPLOYER_PRIVATE_KEY=0x...  # Your deployment account private key

# Base Sepolia Testnet
NEXT_PUBLIC_BASE_RPC_URL=https://sepolia.base.org
NEXT_PUBLIC_PAUTO_VAULT_ADDRESS=0x...  # Set after deployment

# Fee recipient (where platform fees go)
FEE_RECIPIENT_ADDRESS=0x...
PRIMARY_STRATEGY_ADDRESS=0x...
FALLBACK_STRATEGY_ADDRESS=0x...

# Optional
REPORT_GAS=true
COINMARKETCAP_API_KEY=your_key
BASESCAN_API_KEY=your_key
```

---

## Testing

### Run All Tests

```bash
npx hardhat test
```

### Run Specific Test File

```bash
npx hardhat test test/PawasaveAutoVault.test.ts
```

### Run Tests with Gas Report

```bash
REPORT_GAS=true npx hardhat test
```

### Run Tests with Coverage

```bash
npx hardhat coverage
```

---

## Local Development

### Start Local Hardhat Node

```bash
npx hardhat node
```

This starts an Ethereum JSON-RPC server at `http://127.0.0.1:8545`

### Deploy to Local Network (in another terminal)

```bash
npx hardhat run scripts/deploy-pauto.ts --network localhost
```

---

## Deployment

### Deploy to Base Sepolia Testnet

```bash
npx hardhat run scripts/deploy-pauto.ts --network baseSepolia
```

**Output will show:**
- Vault address
- Token address
- Environment variables to add to `.env.local`

### Deploy to Base Mainnet

```bash
npx hardhat run scripts/deploy-pauto.ts --network baseMainnet
```

⚠️ **IMPORTANT**: Triple-check addresses and configuration before mainnet deployment!

---

## Test Scenarios

### Scenario 1: Flexible Deposit & Withdrawal

```bash
npx hardhat test --grep "Flexible Deposits"
```

**What it tests:**
- Deposit without lock
- Immediate withdrawal
- Share calculation

### Scenario 2: Fixed Deposits with Locks

```bash
npx hardhat test --grep "Fixed Deposits"
```

**What it tests:**
- 30-day lock
- 90-day lock
- 180-day lock
- 365-day lock
- Early withdrawal rejection
- Post-unlock withdrawal

### Scenario 3: Yield Harvesting

```bash
npx hardhat test --grep "Yield Harvesting"
```

**What it tests:**
- Yield calculation
- 6% platform fee
- Fee distribution
- Only harvester can harvest

### Scenario 4: Lock Enforcement

```bash
npx hardhat test --grep "Lock Checking"
```

**What it tests:**
- Active lock detection
- Next unlock time
- Post-unlock status clear

### Scenario 5: Admin Functions

```bash
npx hardhat test --grep "Admin Functions"
```

**What it tests:**
- Fee updates (max 15%)
- Strategy updates
- Fee recipient updates

### Scenario 6: Pause/Unpause

```bash
npx hardhat test --grep "Pause"
```

**What it tests:**
- Emergency pause
- Operations blocked while paused
- Unpause functionality

---

## Frontend Integration

### 1. Update Environment Variables

Add to `.env.local`:

```env
NEXT_PUBLIC_PAUTO_VAULT_ADDRESS=0x...  # From deployment output
NEXT_PUBLIC_BASE_RPC_URL=https://sepolia.base.org
```

### 2. Use P-AUTO in Components

```typescript
import { initPAutoManager, PAutoVaultManager } from '@/lib/pauto-vault'

// In your component
async function handleDeposit() {
  try {
    const manager = await initPAutoManager(process.env.NEXT_PUBLIC_PAUTO_VAULT_ADDRESS!)
    
    // Flexible deposit
    const result = await manager.depositFlexible(
      PAutoVaultManager.parseAmount('100'), // 100 cNGN
      userAddress
    )
    console.log('Deposit successful:', result.txHash)
    
  } catch (error) {
    console.error('Deposit failed:', error)
  }
}
```

### 3. Check Lock Status

```typescript
const manager = await initPAutoManager(vaultAddress)
const hasLock = await manager.hasActiveLock(userAddress)
const nextUnlock = await manager.getNextUnlockTime(userAddress)

if (hasLock) {
  console.log('Funds locked until:', new Date(nextUnlock! * 1000))
}
```

### 4. Get Vault Stats

```typescript
const stats = await manager.getVaultStats(userAddress)
console.log({
  totalAssets: PAutoVaultManager.formatAmount(stats.totalAssets),
  userShares: PAutoVaultManager.formatAmount(stats.userShares),
  yieldAccrued: PAutoVaultManager.formatAmount(stats.userYieldAccrued),
  hasActiveLock: stats.userHasActiveLock,
})
```

---

## Troubleshooting

### Error: "Contract not deployed"

Check that `NEXT_PUBLIC_PAUTO_VAULT_ADDRESS` is set correctly in `.env.local`

### Error: "Funds still locked"

User is trying to withdraw before lock period ends. Use `getNextUnlockTime()` to show when they can withdraw.

### Error: "Not harvester"

Only accounts with HARVESTER_ROLE can call `harvestYield()`. Grant role via admin function.

### Error: "Fee cannot exceed 15%"

Platform fee is hardcoded to max 15%. Check fee amount before calling `updatePlatformFee()`.

### Gas too high

Use `REPORT_GAS=true` to see which functions use the most gas and optimize accordingly.

---

## Gas Optimization

### Typical Gas Costs (Base Sepolia)

- **depositFlexible**: ~180,000 gas
- **depositFixed**: ~190,000 gas
- **withdraw**: ~140,000 gas
- **harvestYield**: ~120,000 gas
- **updatePlatformFee**: ~45,000 gas

### Ways to Optimize

1. Batch multiple operations
2. Use multicall if available
3. Reduce storage writes
4. Cache view function results

---

## Security Checklist

Before production deployment:

- [ ] Run full test suite: `npx hardhat test`
- [ ] Check coverage: `npx hardhat coverage`
- [ ] Review gas report: `REPORT_GAS=true npm test`
- [ ] Verify contract on Basescan
- [ ] Audit by external firm (recommended)
- [ ] Test emergency pause functionality
- [ ] Test all lock periods manually
- [ ] Test with real cNGN token on testnet
- [ ] Verify fee calculations
- [ ] Test reentrancy protection

---

## Advanced Testing

### Test Forking Base Mainnet

```bash
FORKING=true npx hardhat test
```

This allows testing against real contracts on Base mainnet.

### Test with Real Token

```env
CNGN_TOKEN_ADDRESS=0x2c852e740B62308B747B50b4A42dAB632bEe2e00  # Real cNGN on Base
```

Then deploy:

```bash
npx hardhat run scripts/deploy-pauto.ts --network baseSepolia
```

---

## Continuous Integration

Add to GitHub Actions (`.github/workflows/test.yml`):

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npx hardhat test
      - run: npx hardhat coverage
```

---

## Performance Monitoring

### Track Deployment Costs

```bash
REPORT_GAS=true npx hardhat run scripts/deploy-pauto.ts --network baseSepolia
```

### Monitor Contract State

```typescript
const stats = await manager.getVaultStats(address)
console.log({
  tvl: PAutoVaultManager.formatAmount(stats.totalAssets),
  userFunds: PAutoVaultManager.formatAmount(stats.userShares),
  accruedYield: PAutoVaultManager.formatAmount(stats.userYieldAccrued),
})
```

---

## Next Steps

1. ✅ Run tests locally
2. ✅ Deploy to Base Sepolia
3. ✅ Test with frontend
4. ✅ Get security audit
5. ✅ Deploy to Base Mainnet
6. ✅ Migrate users gradually

---

## Support & Resources

- **Contract**: `contracts/PawasaveAutoVault.sol`
- **Tests**: `test/PawasaveAutoVault.test.ts`
- **Library**: `frontend/src/lib/pauto-vault.ts`
- **Docs**: `PAUTO_DEPLOYMENT_GUIDE.md`
- **Base Docs**: https://docs.base.org
- **OpenZeppelin**: https://docs.openzeppelin.com/contracts

Happy testing! 🚀
