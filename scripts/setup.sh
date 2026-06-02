#!/bin/bash

# P-AUTO Vault Quick Setup Script
# Run: bash scripts/setup.sh

set -e

echo "🚀 P-AUTO Vault Setup"
echo "===================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 16+"
    exit 1
fi
echo "✓ Node.js $(node --version)"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm not found. Please install npm"
    exit 1
fi
echo "✓ npm $(npm --version)"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install
echo "✓ Dependencies installed"

# Check for .env.local
echo ""
if [ ! -f .env.local ]; then
    echo "📝 Creating .env.local from template..."
    cp .env.example .env.local
    echo "✓ Created .env.local - please fill in your configuration"
else
    echo "✓ .env.local already exists"
fi

# Compile contracts
echo ""
echo "🔨 Compiling contracts..."
npx hardhat compile
echo "✓ Contracts compiled"

# Generate TypeChain types
echo ""
echo "📋 Generating TypeChain types..."
npx hardhat typechain
echo "✓ Types generated"

# Run tests
echo ""
echo "🧪 Running tests..."
if npx hardhat test; then
    echo "✓ All tests passed!"
else
    echo "⚠️  Some tests failed. Review output above."
fi

echo ""
echo "===================="
echo "✨ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env.local with your configuration"
echo "2. Run: npm run node (for local development)"
echo "3. In another terminal: npm run deploy:local"
echo "4. See PAUTO_TESTING_GUIDE.md for more info"
echo ""
