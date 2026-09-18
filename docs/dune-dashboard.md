# PawaSave — Dune dashboard (on-chain stocks + IPO)

Goal: a public, **trustless** dashboard showing what PawaSave has bought/sold on-chain —
tokenized stocks (buy & sell volume, net holdings) and the Dangote Refinery **IPO** (DPRI)
+ Nigerian T-Bills (NTBS5).

## Why this works with zero data upload

PawaSave is **custodial**: every user's stock/IPO purchase is executed and held by ONE
omnibus custody wallet on Base mainnet (chain 8453). So all the on-chain footprint we care
about is that single address's ERC-20 transfers:

- **Stock BUY**  → custody *receives* a B20 stock token (`to = custody`) out of a Uniswap V3 / Aerodrome pool.
- **Stock SELL** → custody *sends* the stock token (`from = custody`) into the pool.
- **IPO / T-Bill BUY** → custody *receives* DPRI / NTBS5 from the GetEquity Market (`to = custody`).
- **IPO / T-Bill REDEEM** → custody *sends* it back (`from = custody`).

Dune already indexes every Base ERC-20 transfer (`erc20_base.evt_Transfer`), so no CSV/API
upload is needed — the dashboard reads straight from chain and anyone can verify it.

> **Per-user data is NOT on-chain** (it lives in Supabase). Dune shows *aggregate* platform
> activity only. That's actually the selling point: a verifiable proof-of-activity board.

## The ONE input you must supply

Replace `0xYOUR_CUSTODY_WALLET` in every query with the custody omnibus address — the public
address of `CUSTODY_PRIVATE_KEY` / `FLIPEET_CUSTODY_ADDRESS`. It's just a wallet address
(safe to publish; the private key is never involved). Get it from:
`await (new ethers.Wallet(CUSTODY_PRIVATE_KEY)).address`, or on BaseScan find the wallet
holding the AAPL (`0xb200…eecd1fb`) token balance. Use it **lowercase**.

## Token registry (Base mainnet 8453)

| Symbol | Kind          | Contract                                     | Decimals |
|--------|---------------|----------------------------------------------|----------|
| AAPL   | stock (B20)   | 0xb200000000000000000000c2e324d24d7eecd1fb   | 8 |
| NVDA   | stock (B20)   | 0xb20000000000000000000078ee7ce2fe4908108c   | 8 |
| META   | stock (B20)   | 0xb2000000000000000000008bc8786b856e61707c   | 8 |
| GOOGL  | stock (B20)   | 0xb2000000000000000000002d0ba3164cc74f58b7   | 8 |
| AMZN   | stock (B20)   | 0xb200000000000000000000d9192b6b456483c2e8   | 8 |
| MSFT   | stock (B20)   | 0xb200000000000000000000ab99cfa739e253872b   | 8 |
| MSTR   | stock (B20)   | 0xb2000000000000000000004884b426556b92883d   | 8 |
| SNDK   | stock (B20)   | 0xb200000000000000000000397293cb8cda9a10c5   | 8 |
| SPCX   | stock (B20)   | 0xb2000000000000000000007b9fcbd005511acbd5   | 8 |
| TSLA   | stock (B20)   | 0xb2000000000000000000001e800a7f5189430cd0   | 8 |
| DPRI   | IPO (Dangote) | 0xc68b460fe4c916fd17d6ab6b181a409c763002d9   | 18 |
| NTBS5  | T-Bill        | 0x7d7177214b2340e8046c9e802ef7de19c7c0f2f1   | 18 |

USDC (Base, 6-dp): `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
cNGN (GetEquity payout, 6-dp): `0x46c85152bfe9f96829aa94755d9f915f9b10ef5f`

---

## Query 1 — Stocks: shares bought vs sold, per ticker (totals)

```sql
WITH custody AS (SELECT 0xYOUR_CUSTODY_WALLET AS addr),
tokens (contract_address, symbol, dec) AS (VALUES
  (0xb200000000000000000000c2e324d24d7eecd1fb, 'AAPL', 8),
  (0xb20000000000000000000078ee7ce2fe4908108c, 'NVDA', 8),
  (0xb2000000000000000000008bc8786b856e61707c, 'META', 8),
  (0xb2000000000000000000002d0ba3164cc74f58b7, 'GOOGL',8),
  (0xb200000000000000000000d9192b6b456483c2e8, 'AMZN', 8),
  (0xb200000000000000000000ab99cfa739e253872b, 'MSFT', 8),
  (0xb2000000000000000000004884b426556b92883d, 'MSTR', 8),
  (0xb200000000000000000000397293cb8cda9a10c5, 'SNDK', 8),
  (0xb2000000000000000000007b9fcbd005511acbd5, 'SPCX', 8),
  (0xb2000000000000000000001e800a7f5189430cd0, 'TSLA', 8)
)
SELECT
  t.symbol,
  SUM(CASE WHEN e.to   = c.addr THEN e.value / power(10, t.dec) ELSE 0 END) AS shares_bought,
  SUM(CASE WHEN e."from"= c.addr THEN e.value / power(10, t.dec) ELSE 0 END) AS shares_sold,
  SUM(CASE WHEN e.to   = c.addr THEN e.value / power(10, t.dec)
           WHEN e."from"= c.addr THEN -e.value / power(10, t.dec) ELSE 0 END) AS net_shares_held,
  COUNT(CASE WHEN e.to   = c.addr THEN 1 END) AS buy_txns,
  COUNT(CASE WHEN e."from"= c.addr THEN 1 END) AS sell_txns
FROM erc20_base.evt_Transfer e
JOIN tokens t  ON e.contract_address = t.contract_address
CROSS JOIN custody c
WHERE e.to = c.addr OR e."from" = c.addr
GROUP BY t.symbol
ORDER BY shares_bought DESC;
```

## Query 2 — Stocks: USD volume (values each swap by the USDC moved in the same tx)

```sql
WITH custody AS (SELECT 0xYOUR_CUSTODY_WALLET AS addr),
usdc AS (SELECT 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 AS addr),
tokens (contract_address, symbol) AS (VALUES
  (0xb200000000000000000000c2e324d24d7eecd1fb,'AAPL'),(0xb20000000000000000000078ee7ce2fe4908108c,'NVDA'),
  (0xb2000000000000000000008bc8786b856e61707c,'META'),(0xb2000000000000000000002d0ba3164cc74f58b7,'GOOGL'),
  (0xb200000000000000000000d9192b6b456483c2e8,'AMZN'),(0xb200000000000000000000ab99cfa739e253872b,'MSFT'),
  (0xb2000000000000000000004884b426556b92883d,'MSTR'),(0xb200000000000000000000397293cb8cda9a10c5,'SNDK'),
  (0xb2000000000000000000007b9fcbd005511acbd5,'SPCX'),(0xb2000000000000000000001e800a7f5189430cd0,'TSLA')
),
-- every tx where custody moved a stock token (a buy or a sell)
stock_txs AS (
  SELECT e.evt_tx_hash, e.evt_block_time, t.symbol,
         CASE WHEN e.to = c.addr THEN 'buy' ELSE 'sell' END AS side
  FROM erc20_base.evt_Transfer e
  JOIN tokens t ON e.contract_address = t.contract_address
  CROSS JOIN custody c
  WHERE e.to = c.addr OR e."from" = c.addr
),
-- USDC that moved to/from custody in those same txs
usdc_legs AS (
  SELECT u.evt_tx_hash,
         SUM(CASE WHEN u."from" = c.addr THEN u.value ELSE 0 END) / 1e6 AS usdc_out,  -- spent on a buy
         SUM(CASE WHEN u.to    = c.addr THEN u.value ELSE 0 END) / 1e6 AS usdc_in     -- received on a sell
  FROM erc20_base.evt_Transfer u
  CROSS JOIN custody c CROSS JOIN usdc
  WHERE u.contract_address = usdc.addr AND (u."from" = c.addr OR u.to = c.addr)
  GROUP BY u.evt_tx_hash
)
SELECT s.symbol,
       SUM(CASE WHEN s.side='buy'  THEN l.usdc_out ELSE 0 END) AS usd_bought,
       SUM(CASE WHEN s.side='sell' THEN l.usdc_in  ELSE 0 END) AS usd_sold
FROM stock_txs s
JOIN usdc_legs l ON s.evt_tx_hash = l.evt_tx_hash
GROUP BY s.symbol
ORDER BY usd_bought DESC;
```

## Query 3 — IPO & T-Bills (GetEquity): units acquired + cNGN spent

```sql
WITH custody AS (SELECT 0xYOUR_CUSTODY_WALLET AS addr),
cngn AS (SELECT 0x46c85152bfe9f96829aa94755d9f915f9b10ef5f AS addr),
assets (contract_address, symbol, kind) AS (VALUES
  (0xc68b460fe4c916fd17d6ab6b181a409c763002d9, 'DPRI',  'IPO (Dangote Refinery)'),
  (0x7d7177214b2340e8046c9e802ef7de19c7c0f2f1, 'NTBS5', 'Nigerian T-Bill S5')
),
buys AS (
  SELECT e.evt_tx_hash, e.evt_block_time, a.symbol, a.kind,
         e.value / 1e18 AS units
  FROM erc20_base.evt_Transfer e
  JOIN assets a ON e.contract_address = a.contract_address
  CROSS JOIN custody c
  WHERE e.to = c.addr           -- custody received = a purchase for a user
),
cngn_out AS (
  SELECT n.evt_tx_hash, SUM(n.value)/1e6 AS cngn_spent
  FROM erc20_base.evt_Transfer n
  CROSS JOIN custody c CROSS JOIN cngn
  WHERE n.contract_address = cngn.addr AND n."from" = c.addr
  GROUP BY n.evt_tx_hash
)
SELECT b.symbol, b.kind,
       COUNT(*)          AS purchases,
       SUM(b.units)      AS total_units,
       SUM(COALESCE(o.cngn_spent,0)) AS total_cngn_spent
FROM buys b
LEFT JOIN cngn_out o ON b.evt_tx_hash = o.evt_tx_hash
GROUP BY b.symbol, b.kind
ORDER BY total_units DESC;
```

## Query 4 — Daily activity (time-series for a line/area chart)

```sql
WITH custody AS (SELECT 0xYOUR_CUSTODY_WALLET AS addr),
tokens (contract_address, symbol, kind, dec) AS (VALUES
  (0xb200000000000000000000c2e324d24d7eecd1fb,'AAPL','stock',8),
  (0xb20000000000000000000078ee7ce2fe4908108c,'NVDA','stock',8),
  (0xb2000000000000000000008bc8786b856e61707c,'META','stock',8),
  (0xb2000000000000000000002d0ba3164cc74f58b7,'GOOGL','stock',8),
  (0xb200000000000000000000d9192b6b456483c2e8,'AMZN','stock',8),
  (0xb200000000000000000000ab99cfa739e253872b,'MSFT','stock',8),
  (0xb2000000000000000000004884b426556b92883d,'MSTR','stock',8),
  (0xb200000000000000000000397293cb8cda9a10c5,'SNDK','stock',8),
  (0xb2000000000000000000007b9fcbd005511acbd5,'SPCX','stock',8),
  (0xb2000000000000000000001e800a7f5189430cd0,'TSLA','stock',8),
  (0xc68b460fe4c916fd17d6ab6b181a409c763002d9,'DPRI','ipo',18),
  (0x7d7177214b2340e8046c9e802ef7de19c7c0f2f1,'NTBS5','tbill',18)
)
SELECT date_trunc('day', e.evt_block_time) AS day, t.kind,
       COUNT(CASE WHEN e.to = c.addr THEN 1 END)  AS buys,
       COUNT(CASE WHEN e."from" = c.addr THEN 1 END) AS sells
FROM erc20_base.evt_Transfer e
JOIN tokens t ON e.contract_address = t.contract_address
CROSS JOIN custody c
WHERE e.to = c.addr OR e."from" = c.addr
GROUP BY 1, 2
ORDER BY 1;
```

## Assembling the dashboard

1. Create each query above at dune.com/queries (pick **DuneSQL / Base**), replace the
   custody address, Run, and **Add visualization**:
   - Q1 → Bar chart (shares_bought vs shares_sold) + a Table.
   - Q2 → Bar chart (usd_bought vs usd_sold).
   - Q3 → Counter/Table (IPO units + cNGN spent) — the headline "IPO bought so far".
   - Q4 → Stacked area (buys/sells over time, split by kind).
2. New Dashboard → add all the visualizations → publish. Share the public URL.

### Caveats
- Values every fill by the USDC/cNGN that moved with it — so it captures fees/slippage as
  actually paid, which is what you want for "volume".
- If a B20 token or the GetEquity token isn't yet in Dune's decoded set, `erc20_base.evt_Transfer`
  still has it (it decodes ALL ERC-20 Transfer logs), so these work regardless.
- Aerodrome/Uniswap routing doesn't matter here — we key on the token landing in/out of
  custody, not on which DEX filled it.
- Redemptions/rebalances by custody would also count as "sells"; for these products that's
  rare, but note it if a number looks off.
```
