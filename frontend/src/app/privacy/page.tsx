import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Privacy Policy — PawaSave',
  description: 'PawaSave privacy policy. Learn how we collect, use, and protect your personal data.',
}

export default function PrivacyPage() {
  return (
    <div className="min-h-dvh bg-slate-950 text-white">
      <header className="px-6 pt-14 pb-8 max-w-2xl mx-auto">
        <Link href="/" className="inline-block mb-6 text-emerald-400 text-sm font-medium hover:underline">&larr; Back to App</Link>
        <h1 className="text-4xl font-bold tracking-tight mb-2">Privacy Policy</h1>
        <p className="text-slate-400 text-sm">Last updated: April 19, 2026</p>
      </header>

      <main className="max-w-2xl mx-auto px-6 pb-20 space-y-10">
        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">1. Introduction</h2>
          <p className="text-slate-300 leading-relaxed">
            PawaSave (&quot;we,&quot; &quot;our,&quot; or &quot;the Platform&quot;) is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your personal information when you use
            our mobile web application and related services. By using PawaSave, you agree to the practices described in this policy.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">2. Information We Collect</h2>
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold text-white mb-1">2.1 Account Information</h3>
              <p className="text-slate-300 leading-relaxed">
                When you register, we collect your email address, display name, and password (securely hashed). We never store plaintext passwords.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-1">2.2 KYC Verification Data</h3>
              <p className="text-slate-300 leading-relaxed">
                To comply with Nigerian financial regulations, we collect your Bank Verification Number (BVN) or National Identification Number (NIN) for identity verification. We store only a one-way hash of these numbers — the original numbers are not stored in our database after verification.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-1">2.3 Financial Transaction Data</h3>
              <p className="text-slate-300 leading-relaxed">
                We record your deposit, withdrawal, savings, and Esusu contribution transactions including amounts, timestamps, and status. This data is necessary to operate your account and provide transaction history.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-1">2.4 Blockchain Data</h3>
              <p className="text-slate-300 leading-relaxed">
                Your personal deposit address on the Base L2 blockchain is stored with your account. Blockchain transactions are inherently public. We do not control the public nature of on-chain data.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-1">2.5 Usage Data</h3>
              <p className="text-slate-300 leading-relaxed">
                We may collect information about how you interact with the Platform, including device type, browser, IP address, and pages visited. This is used to improve the service and troubleshoot issues.
              </p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">3. How We Use Your Information</h2>
          <ul className="list-disc list-inside text-slate-300 space-y-2 leading-relaxed">
            <li>To create and manage your PawaSave account</li>
            <li>To process deposits, withdrawals, and savings transactions</li>
            <li>To verify your identity (KYC) in compliance with Nigerian regulations</li>
            <li>To facilitate Esusu savings circles and group payouts</li>
            <li>To allocate funds to yield pools (Morpho, Xend Asset Chain)</li>
            <li>To communicate important account and service updates</li>
            <li>To prevent fraud, unauthorized access, and security threats</li>
            <li>To improve the Platform functionality and user experience</li>
            <li>To comply with applicable laws and regulations</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">4. Third-Party Services</h2>
          <p className="text-slate-300 leading-relaxed mb-3">
            We integrate with the following third-party services to operate the Platform. Each has their own privacy policies:
          </p>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-white text-sm font-medium">Supabase</span>
              <span className="text-slate-400 text-sm">Database, authentication, &amp; storage</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-white text-sm font-medium">FlintAPI</span>
              <span className="text-slate-400 text-sm">Naira on-ramp &amp; off-ramp</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-white text-sm font-medium">Xend Finance</span>
              <span className="text-slate-400 text-sm">Yield pools &amp; ramp services</span>
            </div>
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <span className="text-white text-sm font-medium">Base (Coinbase L2)</span>
              <span className="text-slate-400 text-sm">Blockchain network for USDC</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-white text-sm font-medium">Vercel</span>
              <span className="text-slate-400 text-sm">Hosting &amp; deployment</span>
            </div>
          </div>
          <p className="text-slate-400 text-sm mt-3">
            We share only the minimum data necessary with each provider (e.g., transaction amounts with FlintAPI, user identifiers with Xend Finance). We never sell your data to third parties.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">5. Data Security</h2>
          <p className="text-slate-300 leading-relaxed mb-3">
            We implement multiple layers of security to protect your data:
          </p>
          <ul className="list-disc list-inside text-slate-300 space-y-2 leading-relaxed">
            <li>All data is transmitted over HTTPS with TLS encryption</li>
            <li>Passwords are hashed using industry-standard bcrypt via Supabase Auth</li>
            <li>KYC identity numbers are stored only as one-way hashes (SHA-256)</li>
            <li>API keys and secrets are stored server-side only — never exposed to the browser</li>
            <li>Row-Level Security (RLS) in Supabase ensures users can only access their own data</li>
            <li>Rate limiting (30 requests/minute) and security headers protect against abuse</li>
            <li>Webhook signatures are verified (HMAC for FlintAPI, RSA for Xend Finance)</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">6. Data Retention</h2>
          <p className="text-slate-300 leading-relaxed">
            We retain your account data for as long as your account is active. Transaction records are kept for a minimum of 6 years in compliance with Nigerian financial record-keeping requirements. If you request account deletion, we will remove your personal data within 30 days, except where retention is required by law.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">7. Your Rights</h2>
          <p className="text-slate-300 leading-relaxed mb-3">
            Under the Nigeria Data Protection Regulation (NDPR) and applicable data protection laws, you have the right to:
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
          <h2 className="text-xl font-bold text-emerald-400 mb-3">8. Cookies &amp; Local Storage</h2>
          <p className="text-slate-300 leading-relaxed">
            PawaSave uses essential cookies and browser localStorage for authentication session management (Supabase Auth tokens). We do not use advertising cookies or third-party tracking cookies. No analytics or behavioral tracking tools are used on the Platform.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">9. Children&apos;s Privacy</h2>
          <p className="text-slate-300 leading-relaxed">
            PawaSave is not intended for use by individuals under the age of 18. We do not knowingly collect personal data from children. If we become aware that we have collected data from a child under 18, we will take steps to delete that data promptly.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">10. Changes to This Policy</h2>
          <p className="text-slate-300 leading-relaxed">
            We may update this Privacy Policy from time to time to reflect changes in our practices or applicable laws. We will notify you of any material changes via email or by posting a notice in the app. Your continued use of PawaSave after any changes constitutes acceptance of the updated policy.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">11. Contact Us</h2>
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
          <Link href="/privacy" className="hover:text-slate-300 transition">Privacy Policy</Link>
          <span>&middot;</span>
          <Link href="/" className="hover:text-slate-300 transition">App</Link>
        </footer>
      </main>
    </div>
  )
}
