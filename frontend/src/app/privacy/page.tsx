import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Privacy Policy — PawaSave',
  description: 'PawaSave privacy policy. Learn how we collect, use, store, and protect your personal data.',
}

export default function PrivacyPage() {
  return (
    <div className="min-h-dvh bg-slate-950 text-white">
      <header className="px-6 pt-14 pb-8 max-w-2xl mx-auto">
        <Link href="/" className="inline-block mb-6 text-emerald-400 text-sm font-medium hover:underline">&larr; Back to App</Link>
        <h1 className="text-4xl font-bold tracking-tight mb-2">Privacy Policy</h1>
        <p className="text-slate-400 text-sm">Last updated: September 1, 2026</p>
      </header>

      <main className="max-w-2xl mx-auto px-6 pb-20 space-y-10">
        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">1. Introduction</h2>
          <p className="text-slate-300 leading-relaxed">
            PawaSave (&quot;we,&quot; &quot;our,&quot; or &quot;the Platform&quot;) is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, store, and safeguard your personal information when you use
            our web application and related services. By using PawaSave, you agree to the practices described in this policy.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">2. Information We Collect</h2>
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold text-white mb-1">2.1 Account Information</h3>
              <p className="text-slate-300 leading-relaxed">
                When you register, we collect your email address and display name, and either a password (which is securely hashed — we never store plaintext passwords) or a Google account identifier if you sign in with Google.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-1">2.2 KYC &amp; Verification Data</h3>
              <p className="text-slate-300 leading-relaxed">
                To comply with Nigerian financial regulations, we verify your identity through our onboarding and KYC partners. This involves your <span className="text-white">Bank Verification Number (BVN)</span>, used to verify you and issue your dedicated Naira account, and a <span className="text-white">biometric liveness (selfie) check</span> required for higher withdrawal limits. We keep only a one-way reference to your BVN in our own systems; the raw BVN and biometric data are handled by the identity partners named in Section 4 under their own privacy terms.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-1">2.3 Financial &amp; Transaction Data</h3>
              <p className="text-slate-300 leading-relaxed">
                We record your deposits, withdrawals, savings, loans, tokenized-stock investments, and Esusu contributions — including amounts, timestamps, counterparties (such as the bank account details used for a payout), and status. This data is necessary to operate your account, hold your funds custodially, and provide transaction history.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-1">2.4 Blockchain Data</h3>
              <p className="text-slate-300 leading-relaxed">
                Your funds are held as cNGN and other tokens on the Base blockchain in wallets that PawaSave controls on your behalf, and you are assigned an on-chain deposit address. Blockchain transactions are inherently public; we do not control the public nature of on-chain data.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-1">2.5 Usage &amp; Device Data</h3>
              <p className="text-slate-300 leading-relaxed">
                We may collect information about how you interact with the Platform, including device type, browser, IP address, and pages visited, to operate the service, secure it, and troubleshoot issues. If you enable notifications, we store a push-notification subscription for your device.
              </p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">3. How We Use Your Information</h2>
          <ul className="list-disc list-inside text-slate-300 space-y-2 leading-relaxed">
            <li>To create and manage your PawaSave account and hold your funds custodially</li>
            <li>To process deposits, withdrawals, savings, loans, and tokenized-stock trades</li>
            <li>To verify your identity (KYC) in compliance with Nigerian regulations</li>
            <li>To facilitate Esusu savings circles and group payouts</li>
            <li>To supply idle funds to the PawasaveLend protocol on Base to generate yield</li>
            <li>To send you transactional emails and, if enabled, push notifications about your account</li>
            <li>To prevent fraud, unauthorized access, and security threats</li>
            <li>To improve the Platform and comply with applicable laws and regulations</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">4. Third-Party Services &amp; Data Sharing</h2>
          <p className="text-slate-300 leading-relaxed mb-3">
            We rely on the following providers to operate the Platform. Each has its own privacy policy, and we share only the minimum data necessary with each:
          </p>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-white text-sm font-medium">Supabase</span>
              <span className="text-slate-400 text-sm">Database, authentication &amp; storage</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-white text-sm font-medium">Strails (Stablesrail)</span>
              <span className="text-slate-400 text-sm">BVN onboarding, dedicated Naira account &amp; deposits</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-white text-sm font-medium">Flipeet</span>
              <span className="text-slate-400 text-sm">Naira withdrawals (off-ramp) to your bank</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-white text-sm font-medium">Sense (usesense.ai)</span>
              <span className="text-slate-400 text-sm">Biometric identity verification (KYC)</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-white text-sm font-medium">HyperFX / Hyperbridge</span>
              <span className="text-slate-400 text-sm">cNGN ↔ USDC conversion for stock trades</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-white text-sm font-medium">Base (Coinbase L2) &amp; Aerodrome</span>
              <span className="text-slate-400 text-sm">Blockchain network &amp; on-chain trading</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-white text-sm font-medium">Hetzner &amp; Cloudflare</span>
              <span className="text-slate-400 text-sm">Server hosting (EU) &amp; content delivery / security</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-white text-sm font-medium">Zoho Mail</span>
              <span className="text-slate-400 text-sm">Transactional email delivery</span>
            </div>
          </div>
          <p className="text-slate-400 text-sm mt-3">
            For example, we share your BVN with our onboarding partner to create your account, and your bank details with our payout partner to process a withdrawal. We never sell your data to third parties.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">5. Where Your Data Is Stored (International Transfer)</h2>
          <p className="text-slate-300 leading-relaxed">
            PawaSave is operated from secure servers located in the <span className="text-white">European Union (Germany)</span>, and our database and authentication provider may store data in the EU or other regions. This means your personal data is transferred to and stored outside Nigeria. By using PawaSave, you consent to this international transfer and storage. We take reasonable steps to ensure your data is protected to a standard consistent with the Nigeria Data Protection Act / Regulation wherever it is processed.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">6. Data Security</h2>
          <p className="text-slate-300 leading-relaxed mb-3">
            We implement multiple layers of security to protect your data:
          </p>
          <ul className="list-disc list-inside text-slate-300 space-y-2 leading-relaxed">
            <li>All data is transmitted over HTTPS with TLS encryption</li>
            <li>Passwords are hashed via Supabase Auth; your 4-digit transaction PIN is hashed server-side with a salted scrypt function</li>
            <li>Repeated incorrect PIN attempts trigger a temporary account lockout</li>
            <li>API keys, wallet keys, and secrets are stored server-side only — never exposed to the browser</li>
            <li>Row-Level Security (RLS) ensures users can only access their own data</li>
            <li>Rate limiting and security headers protect against abuse</li>
            <li>Inbound webhooks (deposits, payouts) are authenticated before any funds move</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">7. Data Retention</h2>
          <p className="text-slate-300 leading-relaxed">
            We retain your account data for as long as your account is active. Transaction and KYC records are kept for a minimum period in line with Nigerian financial record-keeping and AML requirements (generally at least 6 years). If you request account deletion, we will remove your personal data within a reasonable period, except where retention is required by law.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">8. Your Rights</h2>
          <p className="text-slate-300 leading-relaxed mb-3">
            Under the Nigeria Data Protection Act / Regulation (NDPA/NDPR) and applicable data protection laws, you have the right to:
          </p>
          <ul className="list-disc list-inside text-slate-300 space-y-2 leading-relaxed">
            <li><strong className="text-white">Access:</strong> Request a copy of the personal data we hold about you</li>
            <li><strong className="text-white">Correction:</strong> Request correction of inaccurate or incomplete data</li>
            <li><strong className="text-white">Deletion:</strong> Request deletion of your personal data (subject to legal retention requirements)</li>
            <li><strong className="text-white">Portability:</strong> Request your data in a machine-readable format</li>
            <li><strong className="text-white">Objection:</strong> Object to processing of your personal data for specific purposes</li>
          </ul>
          <p className="text-slate-400 text-sm mt-3">
            To exercise any of these rights, contact us at <span className="text-emerald-400">support@pawasave.xyz</span>.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">9. Cookies &amp; Local Storage</h2>
          <p className="text-slate-300 leading-relaxed">
            PawaSave uses essential cookies and browser localStorage for authentication session management (Supabase Auth tokens) and, if you enable them, to store your notification preferences and push subscription. We do not use advertising cookies or third-party behavioral tracking on the Platform.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">10. Children&apos;s Privacy</h2>
          <p className="text-slate-300 leading-relaxed">
            PawaSave is not intended for use by individuals under the age of 18. We do not knowingly collect personal data from children. If we become aware that we have collected data from a child under 18, we will take steps to delete that data promptly.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">11. Changes to This Policy</h2>
          <p className="text-slate-300 leading-relaxed">
            We may update this Privacy Policy from time to time to reflect changes in our practices or applicable laws. We will notify you of any material changes via email or by posting a notice in the app. Your continued use of PawaSave after any changes constitutes acceptance of the updated policy.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">12. Contact Us</h2>
          <p className="text-slate-300 leading-relaxed">
            If you have any questions about this Privacy Policy or our data practices, please contact us:
          </p>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mt-3 space-y-2">
            <p className="text-slate-300 text-sm"><strong className="text-white">Email:</strong> support@pawasave.xyz</p>
            <p className="text-slate-300 text-sm"><strong className="text-white">Website:</strong> https://pawasave.xyz</p>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-slate-800 pt-6 flex items-center justify-center gap-6 text-sm text-slate-500">
          <Link href="/about" className="hover:text-slate-300 transition">About</Link>
          <span>&middot;</span>
          <Link href="/terms" className="hover:text-slate-300 transition">Terms of Service</Link>
          <span>&middot;</span>
          <Link href="/" className="hover:text-slate-300 transition">App</Link>
        </footer>
      </main>
    </div>
  )
}
