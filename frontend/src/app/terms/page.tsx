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
        <p className="text-slate-400 text-sm">Last updated: May 11, 2026</p>
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
            <li className="flex gap-2"><span className="text-emerald-400 flex-shrink-0">•</span> You are not on any governmental sanctions or financial exclusion list.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">3. Account Registration &amp; Security</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              You must provide accurate and complete information when creating your account. You are responsible for maintaining the confidentiality of your login credentials and 6-digit PIN.
            </p>
            <p className="leading-relaxed">
              PawaSave will never ask for your password or PIN via email, phone, or chat. Notify us immediately at support@pawasave.com if you suspect unauthorised access to your account.
            </p>
            <p className="leading-relaxed">
              You may only hold one account. Creating duplicate accounts to circumvent restrictions is prohibited and may result in permanent suspension.
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">4. KYC &amp; Identity Verification</h2>
          <p className="text-slate-300 leading-relaxed">
            To comply with the Central Bank of Nigeria (CBN) regulations and the Money Laundering (Prevention and Prohibition) Act, you must complete identity verification (KYC) before making deposits or withdrawals. We collect your BVN or NIN solely for verification purposes. We store only a one-way hash — the original numbers are not retained after verification. Full KYC details are described in our{' '}
            <Link href="/privacy" className="text-emerald-400 hover:underline">Privacy Policy</Link>.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">5. Deposits &amp; Withdrawals</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              Deposits are processed in Nigerian Naira (NGN) and converted to USDC at the prevailing market rate at the time of deposit. Withdrawals convert USDC back to NGN at the rate applicable at the time of withdrawal. Exchange rate fluctuations are a normal feature of currency conversion and do not constitute a loss of service.
            </p>
            <p className="leading-relaxed">
              A service fee of up to <span className="text-white font-medium">1.5%</span> applies to on-ramp and off-ramp transactions. The exact fee is displayed before you confirm any transaction. Fees are subject to change with 7 days&apos; notice.
            </p>
            <p className="leading-relaxed">
              Withdrawal processing times depend on third-party payment providers and may take up to 2 business days in exceptional circumstances. We are not liable for delays caused by payment processors, banks, or network congestion.
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">6. Flexible Savings (Yield Vault)</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              Funds saved to the Flexible Vault are deployed into the XEND Finance Money Market protocol. Users receive <span className="text-white font-medium">33% APY</span> on their flexible vault balance, credited daily. This rate is subject to change based on underlying protocol performance.
            </p>
            <p className="leading-relaxed">
              Flexible vault funds can be withdrawn at any time with no penalty. However, yield is credited daily — withdrawals made before the daily accrual may not include that day&apos;s yield.
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">7. Fixed Savings Locks</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              Fixed Savings Locks allow you to lock funds for 30 to 365 days via the XEND Finance X Auto product. You earn <span className="text-white font-medium">50% APY</span> on the locked amount, paid at maturity.
            </p>
            <p className="leading-relaxed">
              <span className="text-white font-semibold">Early withdrawal:</span> You may withdraw a fixed lock before maturity, but you forfeit all accrued interest and incur a <span className="text-white font-medium">0.5% penalty</span> on the principal. The penalty is retained by PawaSave as a platform fee.
            </p>
            <p className="leading-relaxed">
              Yield rates advertised reflect the user rate. PawaSave retains a spread between the protocol rate and the user rate as platform revenue.
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">8. Savings Goals</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              Savings Goals allow you to set a target amount, choose a contribution frequency (daily, weekly, or monthly), and contribute regularly until the target is reached. Contributions to active goals are locked and earn <span className="text-white font-medium">50% APY</span> (via XEND X Auto) until the goal is completed.
            </p>
            <p className="leading-relaxed">
              <span className="text-white font-semibold">Auto-scheduling:</span> If you enable auto-contributions, PawaSave will automatically deduct the scheduled contribution from your wallet balance at the configured frequency. Ensure your wallet has sufficient balance before each scheduled date. Auto-contributions that fail due to insufficient funds are skipped — no partial deductions occur.
            </p>
            <p className="leading-relaxed">
              <span className="text-white font-semibold">Breaking a goal early:</span> If you break a goal before reaching the target, your principal is returned to your wallet in full. All accrued interest is forfeited and retained by PawaSave as platform revenue.
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">9. Esusu Group Savings</h2>
          <div className="space-y-4 text-slate-300">
            <p className="leading-relaxed">
              Esusu is a cooperative savings product where a group of members contribute a fixed amount per round and each member receives the pooled amount in rotation. While funds are held in the Esusu pool, they earn <span className="text-white font-medium">33% APY</span> via the XEND Money Market.
            </p>
            <p className="leading-relaxed">
              PawaSave does not guarantee the behaviour of other Esusu group members. Members who fail to contribute on time may be removed from the group at the admin&apos;s discretion. PawaSave is not liable for losses arising from member defaults within a group.
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">10. Risk Disclosures</h2>
          <ul className="space-y-3 text-slate-300">
            <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> <span><span className="text-white font-medium">Exchange rate risk:</span> The NGN/USDC rate fluctuates. The naira value of your savings may go up or down relative to the USDC value.</span></li>
            <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> <span><span className="text-white font-medium">Yield rate risk:</span> APY rates depend on the performance of the underlying XEND Finance protocols. Rates may decrease, potentially to zero, in adverse market conditions.</span></li>
            <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> <span><span className="text-white font-medium">Smart contract risk:</span> USDC and the XEND protocols operate on blockchain infrastructure. Smart contract bugs or exploits could result in loss of funds. PawaSave is not liable for losses caused by third-party protocol failures.</span></li>
            <li className="flex gap-2"><span className="text-yellow-400 flex-shrink-0">⚠</span> <span><span className="text-white font-medium">Regulatory risk:</span> Nigerian regulations on crypto assets are evolving. Regulatory changes could affect the availability of features or the platform as a whole.</span></li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">11. Prohibited Uses</h2>
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
          <h2 className="text-xl font-bold text-emerald-400 mb-3">12. Fees Schedule</h2>
          <div className="rounded-xl border border-slate-700 overflow-hidden">
            <table className="w-full text-sm text-slate-300">
              <thead className="bg-slate-800 text-slate-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-3 text-left">Fee Type</th>
                  <th className="px-4 py-3 text-right">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                <tr><td className="px-4 py-3">On-ramp (NGN → USDC)</td><td className="px-4 py-3 text-right">up to 1.5%</td></tr>
                <tr><td className="px-4 py-3">Off-ramp (USDC → NGN)</td><td className="px-4 py-3 text-right">up to 1.5%</td></tr>
                <tr><td className="px-4 py-3">Fixed lock early withdrawal penalty</td><td className="px-4 py-3 text-right">0.5% of principal</td></tr>
                <tr><td className="px-4 py-3">Goal break (interest forfeited)</td><td className="px-4 py-3 text-right">100% of accrued interest</td></tr>
                <tr><td className="px-4 py-3">Flexible vault withdrawal</td><td className="px-4 py-3 text-right">Free</td></tr>
                <tr><td className="px-4 py-3">Esusu contribution</td><td className="px-4 py-3 text-right">Free</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">13. Limitation of Liability</h2>
          <p className="text-slate-300 leading-relaxed">
            To the maximum extent permitted by Nigerian law, PawaSave and its operators shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including loss of profits or data, arising out of your use of the Platform. Our total liability to you for any claim shall not exceed the total fees you paid to PawaSave in the 30 days preceding the claim.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">14. Termination</h2>
          <p className="text-slate-300 leading-relaxed">
            You may close your account at any time by contacting support, provided all funds are first withdrawn. PawaSave reserves the right to suspend or terminate accounts that violate these terms, with or without notice. Upon termination, any outstanding funds will be returned to your verified bank account after applicable compliance checks.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">15. Governing Law</h2>
          <p className="text-slate-300 leading-relaxed">
            These Terms are governed by and construed in accordance with the laws of the Federal Republic of Nigeria. Any disputes arising from these Terms shall be subject to the exclusive jurisdiction of the courts of Lagos State, Nigeria.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">16. Contact Us</h2>
          <p className="text-slate-300 leading-relaxed">
            If you have questions about these Terms, please contact us at{' '}
            <a href="mailto:support@pawasave.com" className="text-emerald-400 hover:underline">support@pawasave.com</a>.
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
