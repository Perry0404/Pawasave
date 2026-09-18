# Company logos for the Invest tab

Drop a company/stock logo here and it shows next to that asset in the Invest tab
(portfolio rows, the buy list, and the market cards). This is the **reliable**
logo source — bundled with the app, no third-party CDN.

## How to add a logo
1. Save the logo as **`<TICKER>.png`** (square-ish, transparent background best,
   ~72–256px). Example: `DANGCEM.png`, `MTNN.png`, `DPRI.png`.
2. Add one line to `LOGO_LOCAL` in
   `frontend/src/components/stock-chart.tsx`:
   `DANGCEM: 'DANGCEM.png',`
3. Deploy. Done.

The `StockLogo` component tries, in order: this local file → the Clearbit logo
for the ticker's mapped domain (`LOGO_DOMAINS`) → a 2-letter monogram. So even
with no file here, a mapped domain still yields a logo, and a missing image never
breaks a row.

## Note on trademarks
These are the marks of the listed companies, shown to identify the stock you're
offering (the same nominative use every broker app relies on). Use the official
logo unaltered; don't imply endorsement or partnership.
