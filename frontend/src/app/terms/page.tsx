import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Terms of Service — PawaSave',
  description: 'PawaSave terms of service. Read our terms before using the platform.',
}

export default function TermsPage() {
  return (
    <div className="min-h-dvh bg-slate-950 text-white">
      <header className="px-6 pt-14 pb-8 max-w-2xl mx-auto">
        <Link href="/" className="inline-block mb-6 text-emerald-400 text-sm font-medium hover:underline">&larr; Back to App</Link>
        <h1 className="text-4xl font-bold tracking-tight mb-2">Terms of Service</h1>
        <p className="text-slate-400 text-sm">Last updated: September 1, 2026</p>
      </header>

      <main className="max-w-2xl mx-auto px-6 pb-20 space-y-10">

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">1. Acceptance of Terms</h2>
          <p className="text-slate-300 leading-relaxed">
            By creating an account or using PawaSave (&quot;Platform,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;), you agree to be bound by these Terms of Service and our{' '}
            <Link href="/privacy" className="text-emerald-400 hover:underline">Privacy Policy</Link>. If you do not agree to these terms, do not access or use the Platform.
            We may update these terms at any time. Continued use after changes constitutes acceptance.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">2. Eligibility</h2>
          <p className="text-slate-300 leading-relaxed">
            You must be at least 18 years old and a resident of Nigeria to use PawaSave. By registering, you confirm that:
          </p>
          <ul className="mt-3 space-y-2 text-slate-300">
            <li className="flex gap-2"><span className="text-emerald-400 flex-shrink-0">•</span> You are at least 18 years of age.</li>
            <li className="flex gap-2"><span className="text-emerald-400 flex-shrink-0">•</span> You have the legal capacity to enter into binding agreements.</li>
            <li className="flex gap-2"><span className="text-emerald-400 flex-shrink-0">•</span> Your use of the Platform complies with all applicable Nigerian laws and regulations.</li>
            <li className="flex gap-2"><span className="text-emerald-400 flex-shrink-0">•</span> You are not a U.S. person and are not on any governmental sanctions or financial exclusion list.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">3. How PawaSave Works (Custodial Model)</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              PawaSave is a <span className="text-white font-medium">custodial</span> savings and investment app. When you deposit, we hold your funds on your behalf as <span className="text-white font-medium">cNGN</span> — a Naira-pegged stablecoin on the Base blockchain — in wallets that PawaSave controls. You interact with your balance through the app; you do not hold the private keys yourself.
            </p>
            <p className="leading-relaxed">
              Balances are denominated <span className="text-white font-medium">1:1 in Naira</span> (₦1 = 1 cNGN). We do <span className="text-white font-medium">not</span> convert your savings balance to US dollars; there is no USD exchange-rate applied to ordinary deposits, withdrawals, or savings. (Certain optional products, such as tokenized-stock Investing in Section 11, involve conversion to other assets and are priced separately.)
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">4. Account Registration &amp; Security</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              You may register with an email and password or with Google sign-in. You must provide accurate and complete information. You are responsible for maintaining the confidentiality of your login credentials and your 4-digit transaction PIN, which authorises withdrawals and loans.
            </p>
            <p className="leading-relaxed">
              PawaSave will never ask for your password or PIN via email, phone, or chat. Notify us immediately at support@pawasave.xyz if you suspect unauthorised access to your account.
            </p>
            <p className="leading-relaxed">
              You may only hold one account. Creating duplicate accounts to circumvent restrictions is prohibited and may result in permanent suspension.
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">5. KYC &amp; Identity Verification</h2>
          <p className="text-slate-300 leading-relaxed">
            To comply with the Central Bank of Nigeria (CBN) regulations and the Money Laundering (Prevention and Prohibition) Act, you must complete identity verification before you can transact. Verification is performed through our regulated onboarding and identity partners:
          </p>
          <ul className="mt-3 space-y-2 text-slate-300">
            <li className="flex gap-2"><span className="text-emerald-400 flex-shrink-0">•</span> <span><span className="text-white font-medium">BVN verification</span> — used by our onboarding partner to verify your identity and issue you a dedicated Naira account number (NUBAN) for deposits.</span></li>
            <li className="flex gap-2"><span className="text-emerald-400 flex-shrink-0">•</span> <span><span className="text-white font-medium">Biometric liveness</span> — a selfie-based liveness check via our KYC partner, required to lift limits and make larger withdrawals.</span></li>
          </ul>
          <p className="text-slate-300 leading-relaxed mt-3">
            We do not store your raw BVN in our own database — we retain only a one-way reference — but the identity partners listed in our{' '}
            <Link href="/privacy" className="text-emerald-400 hover:underline">Privacy Policy</Link> receive and process the underlying data under their own terms.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">6. Deposits &amp; Withdrawals</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              <span className="text-white font-medium">Deposits.</span> You fund your account by bank transfer to the dedicated Naira account (NUBAN) issued to you, or by sending cNGN on Base to your deposit address. Naira received is credited to your balance as cNGN at 1:1 (₦1 = 1 cNGN). No USD conversion is applied.
            </p>
            <p className="leading-relaxed">
              <span className="text-white font-medium">Withdrawals.</span> You withdraw by converting your cNGN balance back to Naira, paid to your verified Nigerian bank account through our payout partner. Withdrawals are subject to your verification tier and applicable daily limits.
            </p>
            <p className="leading-relaxed">
              A service fee of up to <span className="text-white font-medium">1.5%</span> applies to deposits and withdrawals. The exact fee is shown before you confirm any transaction. Fees are subject to change with 7 days&apos; notice.
            </p>
            <p className="leading-relaxed">
              Withdrawal processing times depend on third-party payment providers and the blockchain network, and may be delayed in exceptional circumstances. We are not liable for delays caused by payment processors, banks, or network congestion.
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">7. Flexible Savings — Ajo (Yield Vault)</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              Funds saved to the Flexible Vault (Ajo) are held custodially by PawaSave (currently pooled in the PawasaveLend contract on Base as a holding layer). Any yield is generated through PawaSave&apos;s treasury management, including licensed money-market partners; it is variable, not guaranteed, and may be zero. Advertised rates are indicative targets, not guarantees.
            </p>
            <p className="leading-relaxed">
              Flexible vault funds can be withdrawn at any time subject to available pool liquidity. In the unlikely event that the lending pool has insufficient liquidity, withdrawals may be temporarily delayed until repayments restore liquidity.
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">8. Fixed Savings Locks</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              Fixed Savings Locks let you lock cNGN for a set term (30 to 365 days) at an indicative, term-based APY. Rates are variable, depend on prevailing money-market rates and PawaSave&apos;s treasury management, and are indicative targets rather than guarantees.
            </p>
            <p className="leading-relaxed">
              <span className="text-white font-semibold">Early withdrawal:</span> You may withdraw a fixed lock before maturity, but you forfeit all accrued interest and incur a <span className="text-white font-medium">0.5% penalty</span> on the principal. The penalty is retained by PawaSave as a platform fee.
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">9. Savings Goals</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              Savings Goals let you set a target amount, choose a contribution frequency (daily, weekly, or monthly), and contribute until the target is reached. Contributions to active goals earn yield until the goal is completed.
            </p>
            <p className="leading-relaxed">
              <span className="text-white font-semibold">Auto-scheduling:</span> If you enable auto-contributions, PawaSave will automatically deduct the scheduled amount from your balance at the configured frequency. Auto-contributions that fail due to insufficient funds are skipped — no partial deductions occur.
            </p>
            <p className="leading-relaxed">
              <span className="text-white font-semibold">Breaking a goal early:</span> If you break a goal before reaching the target, your principal is returned to your balance less a <span className="text-white font-medium">0.5% breaking fee</span>, and any accrued interest is forfeited. The breaking fee is retained by PawaSave as platform revenue.
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">10. Esusu Group Savings</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              Esusu is a cooperative savings product where a group of members contribute a fixed amount per round and each member receives the pooled amount in rotation. While funds are held in the Esusu pool, any yield is generated through PawaSave&apos;s treasury management; it is variable, not guaranteed, and may be zero.
            </p>
            <p className="leading-relaxed">
              PawaSave does not guarantee the behaviour of other Esusu group members. Members who fail to contribute on time may be removed from the group at the admin&apos;s discretion. PawaSave is not liable for losses arising from member defaults within a group.
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">11. Tokenized Stock Investing</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              The Invest feature lets you buy fractional exposure to tokenized US stocks (for example Apple, Nvidia, Alphabet, and Meta) issued on Base by third-party tokenized-equity issuers. When you invest, your cNGN is converted to the tokenized stock, which PawaSave holds custodially on your behalf. When you sell, the stock is converted back to cNGN and credited to your balance. By using this feature you acknowledge:
            </p>
            <ul className="space-y-2 list-none">
              <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> Tokenized stocks are <span className="text-white">not available to U.S. persons</span> and are offered only where permitted.</li>
              <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> Prices track the underlying stock and can rise or fall; the value of your holding may go down as well as up.</li>
              <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> Buying is free; a flat <span className="text-white font-medium">₦500 fee</span> applies to each sale and is retained by PawaSave.</li>
              <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> Execution depends on on-chain liquidity and third-party issuers; PawaSave does not guarantee a price or the availability of any particular stock.</li>
            </ul>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">12. Asset-Backed Borrowing</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              PawaSave offers asset-backed borrowing: you may borrow cNGN against collateral you already hold with us — your fixed savings locks or eligible held assets such as tokenized stocks — without selling them. The underlying PawasaveLend pool on Base holds supplied balances as a custodial holding layer and does not currently offer open pool borrowing. By borrowing you acknowledge:
            </p>
            <ul className="space-y-2 list-none">
              <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> Positions may be partially liquidated if collateral value falls below the liquidation threshold, or if a loan passes its due date and grace period.</li>
              <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> Smart contracts carry risk. Funds are at risk of loss.</li>
              <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> Protocol rates are variable and not guaranteed.</li>
              <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> An origination fee and interest apply to all borrowing, disclosed before you borrow.</li>
            </ul>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">13. Risk Disclosures</h2>
          <ul className="space-y-3 text-slate-300">
            <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> <span><span className="text-white font-medium">Stablecoin &amp; custody risk:</span> Your balance is held as cNGN in wallets PawaSave controls. cNGN aims to stay pegged to the Naira but is issued by a third party; a loss of peg or an issuer failure could affect your balance.</span></li>
            <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> <span><span className="text-white font-medium">Yield rate risk:</span> Yield is variable and not guaranteed. It depends on prevailing money-market rates and PawaSave&apos;s treasury management, and may be reduced to zero.</span></li>
            <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> <span><span className="text-white font-medium">Market risk (Investing):</span> Tokenized stocks fluctuate in value; you may get back less than you invested.</span></li>
            <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> <span><span className="text-white font-medium">Smart contract risk:</span> On-chain contracts may contain undiscovered vulnerabilities. PawaSave is not liable for losses caused by smart contract failures.</span></li>
            <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> <span><span className="text-white font-medium">Regulatory risk:</span> Nigerian regulations on crypto assets are evolving. Regulatory changes could affect the availability of features or the platform.</span></li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">14. Prohibited Uses</h2>
          <p className="text-slate-300 leading-relaxed mb-3">You agree not to use PawaSave to:</p>
          <ul className="space-y-2 text-slate-300">
            <li className="flex gap-2"><span className="text-red-400 flex-shrink-0">✕</span> Launder money, fund terrorism, or finance any illegal activity.</li>
            <li className="flex gap-2"><span className="text-red-400 flex-shrink-0">✕</span> Circumvent AML/KYC requirements through false information.</li>
            <li className="flex gap-2"><span className="text-red-400 flex-shrink-0">✕</span> Use automated bots or scripts to manipulate the platform.</li>
            <li className="flex gap-2"><span className="text-red-400 flex-shrink-0">✕</span> Attempt to exploit, hack, or disrupt the Platform or its infrastructure.</li>
            <li className="flex gap-2"><span className="text-red-400 flex-shrink-0">✕</span> Impersonate another person or provide false identity information.</li>
          </ul>
          <p className="text-slate-300 leading-relaxed mt-3">
            Violation of these prohibitions may result in immediate account suspension, fund freezing, and reporting to relevant authorities including the EFCC or CBN.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">15. Fees Schedule</h2>
          <div className="rounded-xl border border-slate-700 overflow-hidden">
            <table className="w-full text-sm text-slate-300">
              <thead className="bg-slate-800 text-slate-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-3 text-left">Fee Type</th>
                  <th className="px-4 py-3 text-right">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                <tr><td className="px-4 py-3">Deposit (on-ramp)</td><td className="px-4 py-3 text-right">up to 1.5%</td></tr>
                <tr><td className="px-4 py-3">Withdrawal (off-ramp)</td><td className="px-4 py-3 text-right">up to 1.5%</td></tr>
                <tr><td className="px-4 py-3">Fixed lock early withdrawal penalty</td><td className="px-4 py-3 text-right">0.5% of principal</td></tr>
                <tr><td className="px-4 py-3">Goal break</td><td className="px-4 py-3 text-right">0.5% + interest forfeited</td></tr>
                <tr><td className="px-4 py-3">Tokenized stock — buy</td><td className="px-4 py-3 text-right">Free</td></tr>
                <tr><td className="px-4 py-3">Tokenized stock — sell</td><td className="px-4 py-3 text-right">₦500 flat</td></tr>
                <tr><td className="px-4 py-3">Flexible vault withdrawal</td><td className="px-4 py-3 text-right">Free</td></tr>
                <tr><td className="px-4 py-3">Esusu contribution</td><td className="px-4 py-3 text-right">Free</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">16. Limitation of Liability</h2>
          <p className="text-slate-300 leading-relaxed">
            To the maximum extent permitted by Nigerian law, PawaSave and its operators shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including loss of profits or data, arising out of your use of the Platform. Our total liability to you for any claim shall not exceed the total fees you paid to PawaSave in the 30 days preceding the claim.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">17. Termination</h2>
          <p className="text-slate-300 leading-relaxed">
            You may close your account at any time by contacting support, provided all funds are first withdrawn. PawaSave reserves the right to suspend or terminate accounts that violate these terms, with or without notice. Upon termination, any outstanding funds will be returned to your verified bank account after applicable compliance checks.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">18. Governing Law</h2>
          <p className="text-slate-300 leading-relaxed">
            These Terms are governed by and construed in accordance with the laws of the Federal Republic of Nigeria. Any disputes arising from these Terms shall be subject to the exclusive jurisdiction of the courts of Lagos State, Nigeria.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">19. Contact Us</h2>
          <p className="text-slate-300 leading-relaxed">
            If you have questions about these Terms, please contact us at{' '}
            <a href="mailto:support@pawasave.xyz" className="text-emerald-400 hover:underline">support@pawasave.xyz</a>.
          </p>
        </section>

        <div className="pt-6 border-t border-slate-700 flex flex-wrap gap-4 text-sm text-slate-500">
          <Link href="/privacy" className="text-emerald-400 hover:underline">Privacy Policy</Link>
          <Link href="/about" className="text-emerald-400 hover:underline">About PawaSave</Link>
          <Link href="/" className="text-emerald-400 hover:underline">Back to App</Link>
        </div>
      </main>
    </div>
  )
}
