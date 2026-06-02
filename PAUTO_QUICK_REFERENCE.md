# P-AUTO Quick Reference

## Installation

```bash
# Windows
scripts\setup.bat

# macOS/Linux
bash scripts/setup.sh

# Manual
npm install
npx hardhat compile
npx hardhat test
```

---

## Testing Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run all tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:gas` | Show gas usage report |
| `npm run test:coverage` | Generate coverage report |
| `npm run test:grep "Flexible"` | Run tests matching pattern |

---

## Local Development

```bash
# Terminal 1: Start Hardhat node
npm run node

# Terminal 2: Deploy to local network
npm run deploy:local
```

---

## Testnet Deployment

```bash
# Setup Base Sepolia RPC URL in .env.local
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org

# Fund deployer with testnet ETH
# Get from: https://faucet.base.org

# Deploy
npm run deploy:sepolia

# Output will show:
# - Vault address
# - Token address
# - Environment variables to add
```

---

## Common Test Scenarios

### Test Flexible Deposits
```bash
npm run test:grep "Flexible Deposits"
```

### Test Fixed Locks
```bash
npm run test:grep "Fixed Deposits"
```

### Test Yield Harvesting
```bash
npm run test:grep "Yield Harvesting"
```

### Test Admin Functions
```bash
npm run test:grep "Admin Functions"
```

### Test All with Gas Report
```bash
npm run test:gas
```

---

## Configuration

### Create .env.local

```bash
cp .env.example .env.local
# Edit .env.local with your settings
```

### Key Environment Variables

```env
# Private key of deployer
DEPLOYER_PRIVATE_KEY=0x...

# Network RPC endpoints
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BASE_MAINNET_RPC_URL=https://mainnet.base.org

# Deployment config
FEE_RECIPIENT_ADDRESS=0x...
PRIMARY_STRATEGY_ADDRESS=0x...
FALLBACK_STRATEGY_ADDRESS=0x...

# Frontend
NEXT_PUBLIC_PAUTO_VAULT_ADDRESS=0x...
```

---

## File Structure

```
contracts/
├── PawasaveAutoVault.sol    # Main vault contract
└── MockERC20.sol             # Test token

test/
└── PawasaveAutoVault.test.ts # Test suite

scripts/
├── deploy-pauto.ts           # Deployment script
├── setup.sh                  # Linux/macOS setup
└── setup.bat                 # Windows setup

frontend/src/lib/
└── pauto-vault.ts            # Frontend integration library

hardhat.config.ts             # Hardhat configuration
package.json                  # Dependencies & scripts
PAUTO_TESTING_GUIDE.md       # Detailed testing guide
```

---

## Troubleshooting

### "Cannot find module 'hardhat'"

```bash
npm install
```

### "Invalid private key"

Check `.env.local` - private key must start with `0x`

```bash
# Get test key from:
npx hardhat node
# Copy from output
```

### "RPC endpoint error"

Verify Base Sepolia URL is correct:
- Base Sepolia: `https://sepolia.base.org`
- Base Mainnet: `https://mainnet.base.org`

### Tests timeout

Increase timeout in hardhat.config.ts or add `--timeout` flag:

```bash
npx hardhat test --timeout 40000
```

### Out of memory

Increase Node.js memory:

```bash
NODE_OPTIONS=--max-old-space-size=4096 npm test
```

---

## Gas Estimates

| Function | Gas | Cost @ 10 gwei |
|----------|-----|---------------|
| depositFlexible | ~180,000 | ~0.0018 ETH |
| depositFixed | ~190,000 | ~0.0019 ETH |
| withdraw | ~140,000 | ~0.0014 ETH |
| harvestYield | ~120,000 | ~0.0012 ETH |

---

## Deployment Checklist

- [ ] `.env.local` configured
- [ ] Deployer account funded (testnet)
- [ ] `npm install` completed
- [ ] `npx hardhat compile` successful
- [ ] `npm test` passes
- [ ] `npm run deploy:sepolia` successful
- [ ] Contract verified on Basescan
- [ ] Frontend `.env.local` updated with vault address
- [ ] Frontend tests pass
- [ ] Ready for production deployment

---

## Documentation

- **Full Testing Guide**: `PAUTO_TESTING_GUIDE.md`
- **Deployment Guide**: `PAUTO_DEPLOYMENT_GUIDE.md`
- **Contract Code**: `contracts/PawasaveAutoVault.sol`
- **Frontend Library**: `frontend/src/lib/pauto-vault.ts`

---

## Support

For issues:
1. Check `PAUTO_TESTING_GUIDE.md`
2. Review test output
3. Check gas reports: `npm run test:gas`
4. See `PAUTO_DEPLOYMENT_GUIDE.md` section "Safety & Security"

---

## Next Steps

1. Run setup script: `scripts/setup.bat` or `bash scripts/setup.sh`
2. All tests pass ✓
3. Deploy locally: `npm run deploy:local`
4. Deploy to testnet: `npm run deploy:sepolia`
5. Integrate into frontend
6. Production deployment to Base mainnet
