"use client"
import { useWallet }    from "@/hooks/use-wallet"
import { useLendPool }  from "@/hooks/use-lend-pool"
import { Header }       from "@/components/protocol/header"
import { StatsBar }     from "@/components/protocol/stats-bar"
import { SupplyPanel }  from "@/components/protocol/supply-panel"
import { BorrowPanel }  from "@/components/protocol/borrow-panel"
import { PositionsPanel } from "@/components/protocol/positions-panel"
import { RefreshCw, ExternalLink, FileText } from "lucide-react"
import Link from "next/link"
import Logo from "@/components/logo"
import { ADDRESSES }    from "@/lib/contracts"
import { shortAddr }    from "@/lib/format"

export default function ProtocolPage() {
  const wallet = useWallet()
  const pool   = useLendPool(wallet.address, wallet.signer)

  const connected = !!wallet.address && !wallet.wrongChain

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
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
        <div className="text-center mb-8 sm:mb-10">
          <div className="inline-flex items-center gap-2 bg-green-900/40 border border-green-800 text-green-400 text-xs font-semibold px-3 py-1.5 rounded-full mb-4">
            <div className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
            First cNGN Lending Pool on Base
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">
            Lend & Borrow <span className="text-brand-400">cNGN</span>
          </h1>
          <p className="text-gray-400 max-w-xl mx-auto text-base sm:text-lg px-2">
            Supply cNGN to earn yield from Nigerian borrowers.
            Borrow cNGN against USDC, USDT, cNGN, tokenized T-bills & RWAs at market rates.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 mt-4">
            <Link
              href="/whitepaper"
              className="inline-flex items-center gap-1.5 text-xs text-brand-400 hover:text-brand-300 transition font-medium"
            >
              <FileText className="w-3.5 h-3.5" />
              Read the Whitepaper
            </Link>
            {ADDRESSES.LEND && (
              <a
                href={`https://basescan.org/address/${ADDRESSES.LEND}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition"
              >
                <ExternalLink className="w-3 h-3" />
                {shortAddr(ADDRESSES.LEND)} on Basescan
              </a>
            )}
          </div>
        </div>

        {/* Stats */}
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

        {/* Panels */}
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
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="font-bold text-white mb-5 text-lg">How it works</h2>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                step: "01", color: "text-green-400",
                title: "Supply cNGN",
                desc: "Deposit cNGN to receive psNGN yield-bearing shares. Your balance grows automatically as borrowers pay interest.",
              },
              {
                step: "02", color: "text-orange-400",
                title: "Post Collateral & Borrow",
                desc: "Deposit USDC as collateral (75% LTV). Borrow cNGN at the current market rate. Use it anywhere.",
              },
              {
                step: "03", color: "text-purple-400",
                title: "Repay & Withdraw",
                desc: "Repay cNGN debt to unlock your collateral. Suppliers redeem psNGN for cNGN + accrued interest anytime.",
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

        <p className="text-center text-xs text-gray-600 max-w-2xl mx-auto">
          PawaSave Protocol is experimental software. Positions can be liquidated if collateral value falls below the liquidation threshold. Do not deposit funds you cannot afford to lose.
        </p>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-800 mt-8">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Logo size={28} />
            <div className="text-sm">
              <span className="font-bold text-white">PawaSave</span>
              <span className="text-gray-500"> Protocol</span>
            </div>
          </div>
          <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm">
            <Link href="/whitepaper" className="text-gray-400 hover:text-white transition">Whitepaper</Link>
            <Link href="/about" className="text-gray-400 hover:text-white transition">About</Link>
            <Link href="/" className="text-gray-400 hover:text-white transition">Savings App</Link>
            <a href="https://basescan.org" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-white transition">Basescan</a>
          </nav>
          <p className="text-xs text-gray-600">© {new Date().getFullYear()} PawaSave · Base L2</p>
        </div>
      </footer>
    </div>
  )
}
