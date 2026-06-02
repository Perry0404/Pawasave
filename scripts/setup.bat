@echo off
REM P-AUTO Vault Quick Setup Script (Windows)
REM Run: scripts\setup.bat

setlocal enabledelayedexpansion

echo 🚀 P-AUTO Vault Setup
echo ====================
echo.

REM Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Node.js not found. Please install Node.js 16+
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo ✓ Node.js %NODE_VERSION%

REM Check npm
where npm >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ npm not found. Please install npm
    exit /b 1
)
for /f "tokens=*" %%i in ('npm --version') do set NPM_VERSION=%%i
echo ✓ npm %NPM_VERSION%

REM Install dependencies
echo.
echo 📦 Installing dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo ❌ npm install failed
    exit /b 1
)
echo ✓ Dependencies installed

REM Check for .env.local
echo.
if not exist .env.local (
    echo 📝 Creating .env.local from template...
    copy .env.example .env.local
    echo ✓ Created .env.local - please fill in your configuration
) else (
    echo ✓ .env.local already exists
)

REM Compile contracts
echo.
echo 🔨 Compiling contracts...
call npx hardhat compile
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Compilation failed
    exit /b 1
)
echo ✓ Contracts compiled

REM Generate TypeChain types
echo.
echo 📋 Generating TypeChain types...
call npx hardhat typechain
if %ERRORLEVEL% NEQ 0 (
    echo ⚠️  TypeChain generation had issues, but continuing...
)
echo ✓ Types generated

REM Run tests
echo.
echo 🧪 Running tests...
call npx hardhat test
if %ERRORLEVEL% NEQ 0 (
    echo ⚠️  Some tests failed. Review output above.
) else (
    echo ✓ All tests passed!
)

echo.
echo ====================
echo ✨ Setup complete!
echo.
echo Next steps:
echo 1. Edit .env.local with your configuration
echo 2. Run: npm run node (for local development)
echo 3. In another terminal: npm run deploy:local
echo 4. See PAUTO_TESTING_GUIDE.md for more info
echo.

pause
