import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'PawaSave Protocol Whitepaper — cNGN Lending Pool on Base',
  description: 'Technical whitepaper for the PawaSave Protocol: the first cNGN lending pool on Base L2. Covers interest rate model, collateral types, liquidation, insurance fund, and governance.',
}

export default function WhitepaperPage() {
  return (
    <div className="min-h-dvh bg-slate-950 text-white">
      <header className="px-6 pt-14 pb-8 max-w-3xl mx-auto">
        <Link href="/" className="inline-block mb-6 text-emerald-400 text-sm font-medium hover:underline">&larr; Back to App</Link>
        <div className="flex items-center gap-3 mb-2">
          <span className="text-xs bg-emerald-900 text-emerald-400 border border-emerald-800 px-2.5 py-1 rounded-full font-semibold">v1.0 — June 2026</span>
          <span className="text-xs text-slate-500">Base Mainnet</span>
        </div>
        <h1 className="text-4xl font-bold tracking-tight mb-3">PawaSave Protocol</h1>
        <p className="text-xl text-slate-400 leading-relaxed">
          The First cNGN Lending Pool on Base L2
        </p>
        <div className="mt-4 flex gap-4 text-sm">
          <a href="/protocol" className="text-emerald-400 hover:underline">Launch App →</a>
          <a href="https://basescan.org/address/0x0f7aa5dc3B540dc22225085d7363A2524856e744" target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-white">Contract on Basescan →</a>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 pb-24 space-y-16">

        {/* Abstract */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">Abstract</h2>
          <p className="text-slate-300 leading-relaxed mb-3">
            PawaSave Protocol is the first on-chain lending and borrowing market for cNGN (Compliant Naira), the Central Bank of Nigeria-compliant stablecoin deployed on Base L2. The protocol enables cNGN holders to supply liquidity and earn yield from borrower interest, while Nigerian individuals and businesses can borrow cNGN against collateral (USDC and cNGN itself) without selling their assets.
          </p>
          <p className="text-slate-300 leading-relaxed">
            Built on Base L2 (Coinbase's Ethereum L2), PawaSave Protocol addresses the absence of native DeFi infrastructure for Nigeria's on-chain naira. All contracts are open-source and deployed at deterministic addresses on Base mainnet.
          </p>
        </section>

        {/* 1. Motivation */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">1. Motivation</h2>
          <p className="text-slate-300 leading-relaxed mb-4">
            cNGN launched on Base in February 2025 and as of mid-2026 has zero DeFi primitives. No lending market, no liquidity pools, no yield protocol exists on Base for cNGN. Holders either keep it idle or bridge to Asset Chain to access Xend Finance's money market.
          </p>
          <p className="text-slate-300 leading-relaxed mb-4">
            This gap is significant. Nigeria has a CBN monetary policy rate of 27% and Treasury Bill yields of 17–22%. Nigerian SMEs borrow at 30–65% annually. These rates create a natural demand for cNGN borrowing that no on-chain protocol serves today.
          </p>
          <p className="text-slate-300 leading-relaxed">
            PawaSave Protocol fills this gap by deploying a permissionless, auditable lending market directly on Base — the chain where cNGN has its deepest liquidity and the backing of Coinbase Ventures.
          </p>
        </section>

        {/* 2. Protocol Architecture */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">2. Protocol Architecture</h2>
          <p className="text-slate-300 leading-relaxed mb-6">The protocol consists of three on-chain contracts and one off-chain price keeper:</p>

          <div className="space-y-4">
            {[
              {
                name: 'PawasaveLend.sol',
                address: '0x0f7aa5dc3B540dc22225085d7363A2524856e744',
                desc: 'Core lending pool. Accepts cNGN deposits and mints psNGN yield-bearing shares. Manages collateral, borrow positions, interest accrual, and liquidations. Inherits ERC20 (psNGN shares), Ownable, ReentrancyGuard, and Pausable from OpenZeppelin v4.',
              },
              {
                name: 'InterestRateModel.sol',
                address: 'Deployed with PawasaveLend',
                desc: 'Jump-rate (kink) interest rate model. Rates rise gradually up to 80% utilization, then jump steeply above the kink to protect liquidity. Parameters: 5% base, 40% multiplier, 300% jump multiplier, 80% kink.',
              },
              {
                name: 'PriceOracle.sol',
                address: 'Deployed with PawasaveLend',
                desc: 'Keeper-managed price oracle. Stores cNGN value per unit of each collateral token. Updated every hour by an authorized keeper wallet reading the live NGN/USD rate from Flipeet and the official cNGN API. Max staleness: 1 hour.',
              },
              {
                name: 'PawasaveAutoVault.sol (P-AUTO)',
                address: '0x68340bCFA0BC5B0100E997534427271e216d1a7f',
                desc: 'ERC4626-compliant yield vault for fixed savings. Users lock cNGN for 30/90/180/365 days and receive pAUTO shares. The vault routes idle cNGN into PawasaveLend for yield, with lock enforcement preventing early withdrawal.',
              },
            ].map(c => (
              <div key={c.name} className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                <div className="flex items-start justify-between gap-4 mb-2">
                  <h3 className="font-bold text-white">{c.name}</h3>
                  <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950 px-2 py-0.5 rounded whitespace-nowrap">{c.address.startsWith('0x') ? `${c.address.slice(0, 10)}…` : c.address}</span>
                </div>
                <p className="text-slate-400 text-sm leading-relaxed">{c.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* 3. Interest Rate Model */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">3. Interest Rate Model</h2>
          <p className="text-slate-300 leading-relaxed mb-4">
            Borrow rates are determined algorithmically by pool utilization. The model uses a two-slope (kink) design:
          </p>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 font-mono text-sm mb-4">
            <p className="text-emerald-400 mb-2">Below kink (util ≤ 80%):</p>
            <p className="text-white mb-4">borrowRate = 5% + utilization × 40%</p>
            <p className="text-emerald-400 mb-2">Above kink (util &gt; 80%):</p>
            <p className="text-white">borrowRate = 37% + (utilization − 80%) × 300%</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 border-b border-slate-800">
                  <th className="text-left py-2">Utilization</th>
                  <th className="text-left py-2">Borrow APR</th>
                  <th className="text-left py-2">Supply APY (after 10% reserve)</th>
                </tr>
              </thead>
              <tbody className="text-slate-300">
                {[
                  ['50%', '25%', '~11%'],
                  ['70%', '33%', '~21%'],
                  ['80% (kink)', '37%', '~27%'],
                  ['85%', '52%', '~40%'],
                  ['90%', '67%', '~54%'],
                ].map(([u, b, s]) => (
                  <tr key={u} className="border-b border-slate-900">
                    <td className="py-2">{u}</td>
                    <td className="py-2 text-orange-400">{b}</td>
                    <td className="py-2 text-emerald-400">{s}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-slate-400 text-sm mt-3">Supply APY = borrowRate × utilization × (1 − reserveFactor). All rates are annualised.</p>
        </section>

        {/* 4. Collateral */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">4. Collateral System</h2>
          <p className="text-slate-300 leading-relaxed mb-4">
            PawaSave Protocol introduces per-token collateral factors — the first protocol to use cNGN as collateral for borrowing cNGN, making it accessible to Nigerian SMEs who hold naira on-chain but not necessarily USDC.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 border-b border-slate-800">
                  <th className="text-left py-2">Collateral</th>
                  <th className="text-left py-2">LTV</th>
                  <th className="text-left py-2">Rationale</th>
                </tr>
              </thead>
              <tbody className="text-slate-300">
                {[
                  ['USDC', '75%', 'Most liquid, dollar-stable, deep market'],
                  ['cNGN', '60%', 'Naira-pegged, more volatile than USDC, lower LTV protects solvency'],
                  ['USDT', '75%', 'Similar risk profile to USDC (when added)'],
                  ['Tokenized T-bills', '70%', 'Stable but less liquid than stablecoins (future)'],
                ].map(([c, ltv, r]) => (
                  <tr key={c} className="border-b border-slate-900">
                    <td className="py-2 font-semibold text-white">{c}</td>
                    <td className="py-2 text-emerald-400">{ltv}</td>
                    <td className="py-2 text-slate-400 text-xs">{r}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-slate-300 leading-relaxed mt-4">
            Collateral factors are adjustable by the protocol owner and bounded at a maximum of 85%. The borrow limit for a position is calculated as the sum of (collateral value × per-token LTV factor) across all collateral tokens.
          </p>
        </section>

        {/* 5. Liquidation */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">5. Liquidation Mechanism</h2>
          <p className="text-slate-300 leading-relaxed mb-4">
            A position becomes liquidatable when its total debt exceeds its borrow limit (i.e., health factor &lt; 1). Any external address may liquidate an unhealthy position.
          </p>
          <div className="grid sm:grid-cols-2 gap-4 mb-4">
            {[
              { label: 'Close Factor', value: '50%', desc: 'Max fraction of debt that can be repaid in one liquidation' },
              { label: 'Liquidation Bonus', value: '10%', desc: 'Liquidator receives 10% more collateral than the debt repaid' },
              { label: 'Protocol Fee', value: '2%', desc: '2% of the liquidation bonus goes to the PawaSave treasury' },
              { label: 'Partial Liquidation', value: 'Yes', desc: 'Only the unhealthy portion is repaid — borrower retains remaining collateral' },
            ].map(item => (
              <div key={item.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                <div className="flex justify-between items-start mb-1">
                  <span className="text-slate-400 text-sm">{item.label}</span>
                  <span className="text-white font-bold">{item.value}</span>
                </div>
                <p className="text-slate-500 text-xs">{item.desc}</p>
              </div>
            ))}
          </div>
          <p className="text-slate-300 leading-relaxed">
            The oracle must not be stale (updated within 1 hour) for liquidations to execute. This prevents manipulative liquidations during oracle gaps.
          </p>
        </section>

        {/* 6. Insurance Fund */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">6. Insurance Fund</h2>
          <p className="text-slate-300 leading-relaxed mb-4">
            20% of all collected reserves are directed to a dedicated insurance fund address. This fund absorbs bad debt in the event that a liquidation is insufficient to cover outstanding borrower debt — protecting suppliers from losses.
          </p>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 font-mono text-sm">
            <p className="text-slate-400 mb-1">Reserve split on collectReserves():</p>
            <p className="text-white">80% → PawaSave treasury</p>
            <p className="text-emerald-400">20% → Insurance fund</p>
          </div>
        </section>

        {/* 7. Revenue */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">7. Protocol Revenue</h2>
          <p className="text-slate-300 leading-relaxed mb-4">PawaSave Protocol captures revenue from seven independent streams:</p>
          <div className="space-y-2">
            {[
              ['Interest Rate Spread', 'Borrow rate minus supply APY — the largest revenue source'],
              ['Reserve Factor (10%)', '10% of all borrower interest accrues to protocol reserves'],
              ['Origination Fee (0.5%)', 'Flat fee on every new loan — paid upfront from loan proceeds'],
              ['Liquidation Protocol Fee (2%)', '2% of the liquidation bonus on every liquidation event'],
              ['Insurance Fund (20% of reserves)', 'Reinvested over time for protocol sustainability'],
              ['On-ramp / Off-ramp Spread', 'PawaSave earns a spread on every NGN ↔ cNGN conversion'],
              ['P-AUTO Platform Fee (6%)', '6% of harvested vault yield from fixed savings locks'],
            ].map(([name, desc], i) => (
              <div key={name} className="flex gap-3 items-start">
                <span className="text-emerald-400 font-bold text-sm mt-0.5 w-5 flex-shrink-0">{i + 1}.</span>
                <div>
                  <span className="text-white font-semibold text-sm">{name}</span>
                  <span className="text-slate-400 text-sm"> — {desc}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 8. P-AUTO Vault */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">8. P-AUTO Fixed Savings Vault</h2>
          <p className="text-slate-300 leading-relaxed mb-4">
            The PawasaveAutoVault (P-AUTO) is an ERC4626-compliant vault that provides fixed-term savings for consumer app users. Users lock cNGN for 30, 90, 180, or 365 days. The vault deposits idle cNGN into PawasaveLend as liquidity, earning supply APY. A 6% platform fee is deducted from harvested yield before distributing to lockers.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 border-b border-slate-800">
                  <th className="text-left py-2">Lock Period</th>
                  <th className="text-left py-2">APY (target)</th>
                  <th className="text-left py-2">Early Withdrawal</th>
                </tr>
              </thead>
              <tbody className="text-slate-300">
                {[
                  ['30 days', '15%', '0.5% penalty on principal + forfeited interest'],
                  ['90 days', '22%', '0.5% penalty on principal + forfeited interest'],
                  ['180 days', '30%', '0.5% penalty on principal + forfeited interest'],
                  ['365 days', '40%', '0.5% penalty on principal + forfeited interest'],
                ].map(([p, apy, e]) => (
                  <tr key={p} className="border-b border-slate-900">
                    <td className="py-2 font-semibold">{p}</td>
                    <td className="py-2 text-emerald-400">{apy}</td>
                    <td className="py-2 text-slate-400 text-xs">{e}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* 9. Risks */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">9. Risks</h2>
          <div className="space-y-3">
            {[
              ['Smart Contract Risk', 'Contracts may contain undiscovered bugs. PawaSave Protocol contracts have not yet undergone a full external security audit. Users should only deposit funds they can afford to lose.'],
              ['Oracle Risk', 'Price feeds are updated by a centralized keeper. Extended oracle downtime would prevent liquidations and borrowing. The 1-hour staleness limit mitigates manipulation.'],
              ['Liquidation Risk', 'Borrowers whose collateral value falls below the liquidation threshold will have their position partially closed. NGN/USD volatility can trigger unexpected liquidations.'],
              ['Concentration Risk', 'cNGN is a relatively new stablecoin with limited circulating supply. Low pool liquidity in early stages may cause supply APY to be volatile.'],
              ['Regulatory Risk', 'cNGN operations are subject to CBN oversight. Regulatory changes in Nigeria could affect the protocol\'s ability to operate.'],
            ].map(([title, desc]) => (
              <div key={title as string} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                <p className="font-semibold text-orange-400 mb-1 text-sm">{title as string}</p>
                <p className="text-slate-400 text-sm leading-relaxed">{desc as string}</p>
              </div>
            ))}
          </div>
        </section>

        {/* 10. Roadmap */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">10. Roadmap</h2>
          <div className="space-y-3">
            {[
              { phase: 'Phase 1 — Now', items: ['PawasaveLend on Base mainnet', 'USDC + cNGN collateral', 'P-AUTO vault for fixed savings', 'PawaSave consumer app integration'] },
              { phase: 'Phase 2 — Q3 2026', items: ['External security audit', 'Aerodrome cNGN/USDC gauge application', 'Tokenized T-bill collateral (Ondo/Risevest)', 'On-chain credit scoring for Esusu members'] },
              { phase: 'Phase 3 — Q4 2026', items: ['Protocol governance token', 'Multi-strategy P-AUTO (conservative + growth tranches)', 'Open merchant API for other Nigerian fintechs', 'Partial liquidation with grace periods'] },
            ].map(item => (
              <div key={item.phase} className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                <h3 className="font-bold text-white mb-2">{item.phase}</h3>
                <ul className="space-y-1">
                  {item.items.map(i => (
                    <li key={i} className="text-slate-400 text-sm flex items-center gap-2">
                      <span className="text-emerald-500">✓</span> {i}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* Footer */}
        <div className="border-t border-slate-800 pt-8 text-center text-slate-500 text-sm">
          <p>PawaSave Protocol — Built on Base L2 · Naira-native DeFi</p>
          <p className="mt-1">
            <a href="/protocol" className="text-emerald-400 hover:underline">Launch App</a>
            {' · '}
            <a href="/terms" className="hover:text-white">Terms</a>
            {' · '}
            <a href="/privacy" className="hover:text-white">Privacy</a>
          </p>
        </div>
      </main>
    </div>
  )
}
