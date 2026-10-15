import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Delete your account — PawaSave',
  description: 'How to delete your PawaSave account and what happens to your data.',
}

// Public page for the Play Store "delete account" URL: deletion must be requestable without the app.
export default function DeleteAccountPage() {
  return (
    <div className="min-h-dvh bg-slate-950 text-white">
      <header className="px-6 pt-14 pb-8 max-w-2xl mx-auto">
        <Link href="/" className="inline-block mb-6 text-emerald-400 text-sm font-medium hover:underline">&larr; Back to App</Link>
        <h1 className="text-4xl font-bold tracking-tight mb-2">Delete your PawaSave account</h1>
        <p className="text-slate-400 text-sm">PawaSave is operated by CASEWINAI LIMITED.</p>
      </header>

      <main className="max-w-2xl mx-auto px-6 pb-20 space-y-10">
        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">In the app</h2>
          <ol className="text-slate-300 leading-relaxed list-decimal pl-5 space-y-1">
            <li>Sign in to PawaSave.</li>
            <li>Go to <span className="text-white">Profile → Delete account</span>.</li>
            <li>Enter your transaction PIN, type DELETE and confirm.</li>
          </ol>
          <p className="text-slate-300 leading-relaxed mt-3">
            Your account must be empty first: withdraw your balance, savings and investments, repay any loan, and leave your Ajo circles and cooperatives. The app shows you exactly what is still open.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">Without the app</h2>
          <p className="text-slate-300 leading-relaxed">
            Email <a href="mailto:support@pawasave.xyz?subject=Account%20deletion%20request" className="text-emerald-400 hover:underline">support@pawasave.xyz</a> from the email address registered on your account, with the subject &quot;Account deletion request&quot;. We will confirm your identity, help you withdraw any remaining money, and delete the account within 30 days.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">What is deleted</h2>
          <ul className="text-slate-300 leading-relaxed list-disc pl-5 space-y-1">
            <li>Your name, phone number, @tag and transaction PIN.</li>
            <li>Your login: you are signed out and cannot sign in to the account again.</li>
            <li>Notification subscriptions on your devices.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold text-emerald-400 mb-3">What we keep, and why</h2>
          <p className="text-slate-300 leading-relaxed">
            Nigerian anti-money-laundering and financial record-keeping rules require us to keep transaction records and identity-verification (KYC) records for at least six years after an account closes. We keep only what the law requires, use it for nothing else, and delete it when the retention period ends. See our <Link href="/privacy" className="text-emerald-400 hover:underline">Privacy Policy</Link>.
          </p>
        </section>
      </main>
    </div>
  )
}
