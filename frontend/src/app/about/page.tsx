import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'About PawaSave — Your Naira Money App',
  description: 'Learn how PawaSave helps Nigerians save in cNGN and earn yield, run Ajo savings circles, invest in stocks, and borrow against their assets.',
}

export default function AboutPage() {
  return (
    <div className="min-h-dvh bg-slate-950 text-white">
      {/* Hero */}
      <header className="px-6 pt-14 pb-10 max-w-2xl mx-auto text-center">
        <Link href="/" className="inline-block mb-6 text-emerald-400 text-sm font-medium hover:underline">&larr; Back to App</Link>
        <h1 className="text-4xl font-bold tracking-tight mb-3">PawaSave</h1>
        <p className="text-lg text-slate-400 leading-relaxed">
          Save, Ajo, Invest &amp; Borrow.<br className="hidden sm:block" />
          Your money app for Nigeria — powered by cNGN on Base.
        </p>
      </header>

      <main className="max-w-2xl mx-auto px-6 pb-20 space-y-14">
        {/* What is PawaSave */}
        <section>
          <h2 className="text-2xl font-bold text-emerald-400 mb-4">What is PawaSave?</h2>
          <p className="text-slate-300 leading-relaxed mb-3">
            PawaSave is a Nigerian money app where you <strong className="text-white">save in cNGN</strong> — the Central Bank of Nigeria-compliant, Naira-pegged stablecoin (₦1 = 1 cNGN) — and put it to work. Earn yield on your savings, run traditional Ajo (Esusu) circles, invest in tokenized US stocks, and borrow against your assets.
          </p>
          <p className="text-slate-300 leading-relaxed">
            We handle the on-chain complexity for you. PawaSave is a <strong className="text-white">custodial</strong> app: you deposit by bank transfer, we hold your cNGN securely on the Base blockchain on your behalf, and you manage everything from a simple app — no crypto wallet required.
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
                    After a quick BVN check, you get your own dedicated Naira account number. Send money to it from any Nigerian bank — no crypto wallet needed.
                  </p>
                </div>
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex items-start gap-4">
                <span className="bg-emerald-600 text-white text-sm font-bold rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0">2</span>
                <div>
                  <h3 className="font-semibold text-white mb-1">Held as cNGN, 1:1</h3>
                  <p className="text-slate-400 text-sm leading-relaxed">
                    Your Naira is credited as cNGN at 1:1 (₦1 = 1 cNGN) and held securely on Base. Your balance stays in Naira — no US-dollar conversion, no exchange-rate surprises.
                  </p>
                </div>
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex items-start gap-4">
                <span className="bg-emerald-600 text-white text-sm font-bold rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0">3</span>
                <div>
                  <h3 className="font-semibold text-white mb-1">Save, Invest &amp; Borrow</h3>
                  <p className="text-slate-400 text-sm leading-relaxed">
                    Earn yield through the PawasaveLend protocol, join Ajo circles, invest in tokenized stocks, or borrow cNGN against your savings and holdings.
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
                    Cash out to any Nigerian bank account. Your cNGN converts back to Naira and lands in your bank — no lock-in for flexible savings.
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
              <h3 className="font-semibold text-white mb-2">💰 cNGN Savings &amp; Yield</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Save in Naira-pegged cNGN and earn variable yield through the PawasaveLend protocol on Base. Flexible savings, fixed locks, and goals.
              </p>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="font-semibold text-white mb-2">🤝 Ajo (Esusu) Circles</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Join traditional rotating savings groups. Contribute each round and receive the pooled amount in rotation — with yield while funds are pooled.
              </p>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="font-semibold text-white mb-2">📈 Tokenized Stock Investing</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Buy fractional shares of tokenized US stocks (like Apple, Nvidia, Alphabet, and Meta) with your cNGN. Buying is free; a flat ₦500 fee applies on sale.
              </p>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="font-semibold text-white mb-2">🏦 Borrow Against Your Assets</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Unlock cash without selling. Borrow cNGN against your savings locks and eligible holdings through the PawaSave lending protocol.
              </p>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="font-semibold text-white mb-2">🏧 Bank-to-App Deposits</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Fund your account with a normal bank transfer to your dedicated Naira account number — no crypto knowledge required.
              </p>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="font-semibold text-white mb-2">✅ KYC Verified</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                BVN verification and biometric liveness keep your account secure and compliant with Nigerian regulations.
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
              <span className="text-white text-sm font-medium">Base (Ethereum Layer 2)</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">Stablecoin</span>
              <span className="text-white text-sm font-medium">cNGN (Naira-pegged)</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">Deposits &amp; Withdrawals</span>
              <span className="text-white text-sm font-medium">Strails (deposits) + Flipeet (payouts)</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">Yield</span>
              <span className="text-white text-sm font-medium">PawasaveLend protocol on Base</span>
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
              <span className="text-slate-400 text-sm">Deposit (on-ramp)</span>
              <span className="text-white text-sm font-medium">up to 1.5%</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">Withdrawal (off-ramp)</span>
              <span className="text-white text-sm font-medium">up to 1.5%</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">Tokenized stock — sell</span>
              <span className="text-white text-sm font-medium">₦500 flat (buying is free)</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-slate-400 text-sm">Vault Save/Withdraw &amp; Esusu</span>
              <span className="text-white text-sm font-medium">Free</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400 text-sm">Early Lock / Goal break</span>
              <span className="text-white text-sm font-medium">0.5% penalty</span>
            </div>
          </div>
          <p className="text-slate-500 text-xs mt-3">
            See the full <Link href="/terms" className="text-emerald-400 hover:underline">Terms of Service</Link> for the complete fee schedule.
          </p>
        </section>

        {/* CTA */}
        <section className="text-center">
          <h2 className="text-2xl font-bold text-white mb-3">Ready to Save Smarter?</h2>
          <p className="text-slate-400 mb-6">Save, run Ajo, invest, and borrow — all in one Naira app.</p>
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
          <Link href="/terms" className="hover:text-slate-300 transition">Terms</Link>
          <span>&middot;</span>
          <Link href="/" className="hover:text-slate-300 transition">App</Link>
        </footer>
      </main>
    </div>
  )
}
