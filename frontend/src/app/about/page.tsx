import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'About PawaSave — Save in Crypto with Naira',
  description: 'Learn how PawaSave helps Nigerians save directly in crypto using fiat, with Esusu savings circles, yield pools, and instant on/off-ramp.',
}

export default function AboutPage() {
  return (
    <div className="min-h-dvh bg-slate-950 text-white">
      {/* Hero */}
      <header className="px-6 pt-14 pb-10 max-w-2xl mx-auto text-center">
        <Link href="/" className="inline-block mb-6 text-emerald-400 text-sm font-medium hover:underline">&larr; Back to App</Link>
        <h1 className="text-4xl font-bold tracking-tight mb-3">PawaSave</h1>
        <p className="text-lg text-slate-400 leading-relaxed">
          Collect naira. Save in dollars. Withdraw anytime.<br className="hidden sm:block" />
          The smartest way for Nigerians to protect and grow their money.
        </p>
      </header>

      <main className="max-w-2xl mx-auto px-6 pb-20 space-y-14">
        {/* What is PawaSave */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">What is PawaSave?</h2>
          <p className="text-slate-300 leading-relaxed mb-3">
            PawaSave is a Nigerian fintech platform that lets you <strong className="text-white">deposit naira and save directly in crypto (USDC)</strong> — a stablecoin pegged 1:1 to the US dollar. Your savings are protected from naira devaluation while remaining instantly accessible whenever you need them.
          </p>
          <p className="text-slate-300 leading-relaxed">
            We handle the complexity of crypto on/off-ramp so you don&apos;t have to. Simply send naira via bank transfer, and PawaSave automatically converts it to USDC and stores it securely in your personal vault on the Base L2 blockchain.
          </p>
        </section>

        {/* How it Works */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">How It Works</h2>
          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex items-start gap-4">
                <span className="bg-emerald-600 text-white text-sm font-bold rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0">1</span>
                <div>
                  <h3 className="font-semibold text-white mb-1">Deposit Naira</h3>
                  <p className="text-slate-400 text-sm leading-relaxed">
                    Send naira from any Nigerian bank account. We generate a unique virtual account for you via FlintAPI or Xend Finance. No crypto wallet needed — just a simple bank transfer.
                  </p>
                </div>
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex items-start gap-4">
                <span className="bg-emerald-600 text-white text-sm font-bold rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0">2</span>
                <div>
                  <h3 className="font-semibold text-white mb-1">Auto-Convert to USDC</h3>
                  <p className="text-slate-400 text-sm leading-relaxed">
                    Your naira is instantly converted to USDC at the current market rate and deposited into your personal USDC vault on the Base L2 blockchain. Each user gets their own non-custodial deposit address.
                  </p>
                </div>
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex items-start gap-4">
                <span className="bg-emerald-600 text-white text-sm font-bold rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0">3</span>
                <div>
                  <h3 className="font-semibold text-white mb-1">Earn Yield</h3>
                  <p className="text-slate-400 text-sm leading-relaxed">
                    Lock your savings to earn interest through Morpho vaults or participate in the Xend Asset Chain yield pool at up to 21% APY. 90% of deposits are auto-allocated to the cNGN yield pool for maximum returns.
                  </p>
                </div>
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex items-start gap-4">
                <span className="bg-emerald-600 text-white text-sm font-bold rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0">4</span>
                <div>
                  <h3 className="font-semibold text-white mb-1">Withdraw Anytime</h3>
                  <p className="text-slate-400 text-sm leading-relaxed">
                    Convert your USDC back to naira and send it to any Nigerian bank account instantly. No lock-in periods for standard savings — your money is always yours.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Key Features */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">Key Features</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="font-semibold text-white mb-2">💰 USDC Savings Vault</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Save in a dollar-pegged stablecoin. Your naira value is protected from inflation and currency devaluation. View balances in both USDC and naira.
              </p>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="font-semibold text-white mb-2">🤝 Esusu Circles</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Join traditional rotating savings groups (ajo/esusu) powered by blockchain. Contribute weekly or monthly with 3-way payment: USDC, naira, or crypto.
              </p>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="font-semibold text-white mb-2">📈 Yield Pools</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Earn up to 50% APY on fixed savings (XEND X Auto) or 33% APY on flexible savings (XEND Money Market). Save to the vault and your money starts earning automatically — no lock-in required.
              </p>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="font-semibold text-white mb-2">🔄 Smart Ramp Routing</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Deposits and withdrawals are routed automatically to the best available provider — FlintAPI, Flipeet, or Xend Finance — for the lowest fee and fastest settlement.
              </p>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="font-semibold text-white mb-2">🏦 Bank-to-Crypto Deposits</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Deposit naira directly from your Nigerian bank account via a virtual bank transfer — no crypto knowledge required. Your funds are instantly converted to USDC and auto-saved.
              </p>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="font-semibold text-white mb-2">✅ KYC Verified</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                BVN or NIN verification ensures account security and regulatory compliance. Quick automated verification gets you started in minutes.
              </p>
            </div>
          </div>
        </section>

        {/* Technology */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">Built on Solid Technology</h2>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">Blockchain</span>
              <span className="text-white text-sm font-medium">Base L2 (Ethereum Layer 2)</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">Stablecoin</span>
              <span className="text-white text-sm font-medium">USDC (Circle)</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">On/Off-Ramp</span>
              <span className="text-white text-sm font-medium">FlintAPI + Xend Finance</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">Yield</span>
              <span className="text-white text-sm font-medium">Morpho Vaults + Xend Asset Chain</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">Backend</span>
              <span className="text-white text-sm font-medium">Supabase (PostgreSQL + Auth)</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400 text-sm">Frontend</span>
              <span className="text-white text-sm font-medium">Next.js (PWA)</span>
            </div>
          </div>
        </section>

        {/* Fee Structure */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">Transparent Fees</h2>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">On-Ramp (Deposit)</span>
              <span className="text-white text-sm font-medium">1.5% PawaSave fee + provider fees</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">Off-Ramp (Withdraw)</span>
              <span className="text-white text-sm font-medium">1.5% PawaSave fee + provider fees</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">Vault Save/Withdraw</span>
              <span className="text-white text-sm font-medium">Free</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">Esusu Contributions</span>
              <span className="text-white text-sm font-medium">Free</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400 text-sm">Early Lock Withdrawal</span>
              <span className="text-white text-sm font-medium">0.5% penalty (no interest)</span>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="text-center">
          <h2 className="text-2xl font-bold text-white mb-3">Ready to Save Smarter?</h2>
          <p className="text-slate-400 mb-6">Join thousands of Nigerians protecting their money from inflation.</p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-3.5 px-8 rounded-xl transition active:scale-[0.98]"
          >
            Get Started Free &rarr;
          </Link>
        </section>

        {/* Footer Links */}
        <footer className="border-t border-slate-800 pt-6 flex items-center justify-center gap-6 text-sm text-slate-500">
          <Link href="/privacy" className="hover:text-slate-300 transition">Privacy Policy</Link>
          <span>&middot;</span>
          <Link href="/about" className="hover:text-slate-300 transition">About</Link>
          <span>&middot;</span>
          <Link href="/" className="hover:text-slate-300 transition">App</Link>
        </footer>
      </main>
    </div>
  )
}
