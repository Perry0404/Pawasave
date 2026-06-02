"use client"
import { useWallet }    from "@/hooks/use-wallet"
import { useLendPool }  from "@/hooks/use-lend-pool"
import { Header }       from "@/components/header"
import { StatsBar }     from "@/components/stats-bar"
import { SupplyPanel }  from "@/components/supply-panel"
import { BorrowPanel }  from "@/components/borrow-panel"
import { PositionsPanel } from "@/components/positions-panel"
import { RefreshCw, ExternalLink } from "lucide-react"
import { ADDRESSES }    from "@/lib/contracts"
import { shortAddr }    from "@/lib/format"

export default function Home() {
  const wallet = useWallet()
  const pool   = useLendPool(wallet.address, wallet.signer)

  const connected = !!wallet.address && !wallet.wrongChain

  return (
    <div className="min-h-screen">
      <Header
        address={wallet.address}
        wrongChain={wallet.wrongChain}
        connecting={wallet.connecting}
        onConnect={wallet.connect}
        onSwitch={wallet.switchChain}
        onDisconnect={wallet.disconnect}
      />

      <main className="max-w-6xl mx-auto px-4 py-8">

        {/* Hero */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 bg-brand-900/40 border border-brand-800 text-brand-400 text-xs font-semibold px-3 py-1.5 rounded-full mb-4">
            <div className="w-1.5 h-1.5 bg-brand-400 rounded-full animate-pulse" />
            First cNGN Lending Pool on Base
          </div>
          <h1 className="text-4xl font-bold text-white mb-3">
            Lend & Borrow <span className="text-brand-400">cNGN</span>
          </h1>
          <p className="text-gray-400 max-w-xl mx-auto text-lg">
            Supply cNGN to earn yield from Nigerian borrowers.
            Borrow cNGN against USDC collateral at market rates.
          </p>

          {ADDRESSES.LEND && (
            <a
              href={`https://basescan.org/address/${ADDRESSES.LEND}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition mt-3"
            >
              <ExternalLink className="w-3 h-3" />
              {shortAddr(ADDRESSES.LEND)} on Basescan
            </a>
          )}
        </div>

        {/* Pool stats */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Pool Stats</h2>
          <button
            onClick={pool.refresh}
            disabled={pool.loading}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${pool.loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
        <StatsBar stats={pool.stats} loading={pool.loading} />

        {/* Not deployed yet banner */}
        {!ADDRESSES.LEND && (
          <div className="bg-orange-950/30 border border-orange-900/50 rounded-2xl p-6 text-center mb-8">
            <p className="text-orange-300 font-semibold mb-1">Lending pool not deployed yet</p>
            <p className="text-orange-400/70 text-sm">Contract address will appear here once deployed to Base mainnet.</p>
          </div>
        )}

        {/* Main panels */}
        <div className="grid md:grid-cols-3 gap-5 mb-8">
          <SupplyPanel
            stats={pool.stats}
            position={pool.position}
            connected={connected}
            txPending={pool.txPending}
            error={pool.error}
            onSupply={pool.supply}
            onWithdraw={pool.withdrawSupply}
          />
          <BorrowPanel
            stats={pool.stats}
            position={pool.position}
            connected={connected}
            txPending={pool.txPending}
            error={pool.error}
            onDepositCollateral={pool.depositCollateral}
            onWithdrawCollateral={pool.withdrawCollateral}
            onBorrow={pool.borrow}
          />
          <PositionsPanel
            position={pool.position}
            connected={connected}
            txPending={pool.txPending}
            error={pool.error}
            onRepay={pool.repay}
            onRepayFull={pool.repayFull}
            onWithdrawCollateral={pool.withdrawCollateral}
            onWithdrawSupply={pool.withdrawSupply}
          />
        </div>

        {/* How it works */}
        <div className="card">
          <h2 className="font-bold text-white mb-5 text-lg">How it works</h2>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                step: "01",
                title: "Supply cNGN",
                desc: "Deposit cNGN into the pool and receive psNGN yield-bearing shares. Your balance grows automatically as borrowers pay interest.",
                color: "text-brand-400",
              },
              {
                step: "02",
                title: "Post Collateral & Borrow",
                desc: "Deposit USDC as collateral (75% LTV). Borrow cNGN at the current market rate. Use it anywhere — pay suppliers, trade, off-ramp to naira.",
                color: "text-orange-400",
              },
              {
                step: "03",
                title: "Repay & Withdraw",
                desc: "Repay your cNGN debt anytime to unlock your collateral. Suppliers redeem psNGN shares for cNGN + accrued interest whenever they need liquidity.",
                color: "text-purple-400",
              },
            ].map(item => (
              <div key={item.step}>
                <div className={`text-3xl font-black ${item.color} mb-2 opacity-40`}>{item.step}</div>
                <h3 className="font-semibold text-white mb-1.5">{item.title}</h3>
                <p className="text-gray-400 text-sm leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Risk disclaimer */}
        <p className="text-center text-xs text-gray-600 mt-6 max-w-2xl mx-auto">
          PawaSave Protocol is experimental software. Smart contracts may contain bugs. Positions can be liquidated if collateral value falls below the liquidation threshold. Do not deposit funds you cannot afford to lose.
        </p>
      </main>
    </div>
  )
}
