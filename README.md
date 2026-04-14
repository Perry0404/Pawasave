# PawaSave 🟢

**Get paid in Naira. Save in USDC. Withdraw anytime — your money is never locked, not even for a minute.**

PawaSave is a fintech platform for Nigerian businesses (especially market traders) that provides:

- **Instant Naira Payments → USDC Savings** — Receive payments in Naira, automatically converted and saved in USDC on Base L2
- **5-Minute Liquidity Guarantee** — Money is instantly available from treasury pool; if settlement takes >5 mins, you earn bonus yield
- **Smart Split + Auto-Esusu** — Automatically split every payment: "60% to vault, 40% to my Esusu group"
- **Esusu/Ajo/Contribution Circles** — Traditional savings groups powered by USDC with emergency pot and majority-vote payouts
- **Daily Market Reports + Pidgin Voice Insights** — "Today you receive ₦1.2M → ₦720k saved in USDC → earned ₦340 interest"

## Architecture

```
pawasave/
├── backend/          NestJS + Prisma + PostgreSQL + BullMQ
│   ├── prisma/       Database schema
│   └── src/
│       ├── modules/
│       │   ├── auth/          Phone + password auth with JWT
│       │   ├── wallet/        Naira + USDC balances, save/withdraw
│       │   ├── payment/       Inbound payments, Paystack webhook, 5-min guarantee
│       │   ├── savings/       Daily interest accrual (5% APY on USDC)
│       │   ├── treasury/      On-chain USDC ops via viem (Base L2)
│       │   ├── esusu/         Groups, contributions, payouts, emergency pot
│       │   ├── split/         Auto-split rules engine
│       │   ├── report/        Daily summaries + pidgin voice scripts
│       │   └── exchange-rate/ NGN/USD rate caching
│       └── common/            Prisma client, decorators
└── frontend/         Next.js 14 + Tailwind CSS
    └── src/
        ├── app/               Pages (App Router)
        ├── components/        Dashboard, Esusu, Split, Reports
        └── lib/               API client, formatters
```

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL
- Redis (for BullMQ job queue)

### Backend Setup

```bash
cd backend
cp .env.example .env          # Edit with your DB/Redis/API credentials
npm install
npx prisma migrate dev --name init
npm run start:dev
```

API runs on `http://localhost:3000` with Swagger at `/api/docs`.

### Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

App runs on `http://localhost:3001` and proxies API calls to the backend.

## Key Flows

### Payment → Save → Split
1. Naira payment arrives (Paystack webhook or manual)
2. **Instant** Naira credit to user wallet (treasury pool backs this)
3. Background: BullMQ job buys USDC on Base L2
4. Smart Split executes: e.g., 60% → USDC vault, 40% → Esusu group
5. If settlement >5 mins, bonus yield credited

### Esusu Cycle
1. Owner creates group (fixed contribution, cycle period, max members)
2. Members join → group auto-starts when full
3. Each cycle: all contribute → pot goes to next member in rotation
4. 5% of each contribution goes to emergency pot
5. Emergency: any member can request → majority vote → instant payout with small yield penalty

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login |
| GET | `/api/wallet/dashboard` | Balances in Naira + USDC |
| POST | `/api/wallet/save` | Naira → USDC vault |
| POST | `/api/wallet/withdraw` | USDC vault → Naira |
| POST | `/api/payments/simulate` | Simulate inbound payment (dev) |
| POST | `/api/payments/webhook/paystack` | Paystack webhook |
| GET | `/api/payments/transactions` | Transaction ledger |
| POST | `/api/split/rules` | Create auto-split rule |
| GET | `/api/split/rules` | List split rules |
| POST | `/api/esusu/create` | Create Esusu group |
| POST | `/api/esusu/join/:groupId` | Join group |
| POST | `/api/esusu/contribute` | Make cycle contribution |
| POST | `/api/esusu/quick-ajo` | One-tap market Ajo creation |
| POST | `/api/esusu/emergency/request` | Request emergency payout |
| POST | `/api/esusu/emergency/vote` | Vote on emergency |
| GET | `/api/reports/daily` | Today's market report + pidgin summary |
| GET | `/api/reports/trend` | Sales trend chart data |

## Tech Stack

- **Backend**: NestJS, Prisma, PostgreSQL, BullMQ (Redis)
- **Blockchain**: Base L2 (USDC), viem for on-chain ops
- **Frontend**: Next.js 14, Tailwind CSS, Recharts
- **Payments**: Paystack integration (webhook-verified)
- **Auth**: JWT + bcrypt

## License

Private — PawaSave
