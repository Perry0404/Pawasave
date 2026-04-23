'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase'
import Logo from '@/components/logo'
import { Lock, Eye, EyeOff, Loader2, CheckCircle } from 'lucide-react'

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)
  const [sessionReady, setSessionReady] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)

  const supabase = createClient()

  useEffect(() => {
    const check = async () => {
      const { data } = await supabase.auth.getSession()
      setSessionReady(!!data.session)
      setCheckingSession(false)
    }
    check()
  }, [supabase.auth])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')

    if (password.length < 6) { setErr('Password must be at least 6 characters'); return }
    if (password !== confirm) { setErr('Passwords do not match'); return }

    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)

    if (error) {
      setErr(error.message)
    } else {
      setDone(true)
    }
  }

  if (checkingSession) {
    return (
      <div className="min-h-dvh bg-slate-950 flex items-center justify-center px-6">
        <div className="text-center">
          <Logo size={44} className="mx-auto mb-4" />
          <Loader2 className="w-5 h-5 animate-spin text-emerald-500 mx-auto" />
          <p className="text-slate-400 text-sm mt-3">Validating reset link...</p>
        </div>
      </div>
    )
  }

  if (!sessionReady) {
    return (
      <div className="min-h-dvh bg-slate-950 flex flex-col items-center justify-center px-6">
        <Logo size={48} className="mb-5" />
        <h1 className="text-xl font-bold text-white mb-2">Reset Link Invalid or Expired</h1>
        <p className="text-slate-400 text-sm text-center max-w-xs mb-6">
          Request another reset email from the login screen and open the latest link.
        </p>
        <a
          href="/"
          className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-6 py-3 rounded-xl transition"
        >
          Back to Sign In
        </a>
      </div>
    )
  }

  if (done) {
    return (
      <div className="min-h-dvh bg-slate-950 flex flex-col items-center justify-center px-6">
        <Logo size={48} className="mb-4" />
        <CheckCircle className="w-12 h-12 text-emerald-500 mb-4" />
        <h1 className="text-xl font-bold text-white mb-2">Password Updated</h1>
        <p className="text-slate-400 text-sm text-center mb-6">Your password has been changed successfully.</p>
        <a
          href="/"
          className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-6 py-3 rounded-xl transition"
        >
          Go to App
        </a>
      </div>
    )
  }

  return (
    <div className="min-h-dvh bg-slate-950 flex flex-col items-center justify-center px-6">
      <Logo size={48} className="mb-5" />
      <h1 className="text-2xl font-bold text-white mb-2">Set New Password</h1>
      <p className="text-slate-400 text-sm text-center mb-8 max-w-xs">Enter your new password below.</p>

      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <div>
          <label className="text-xs font-medium text-slate-400 mb-1.5 block">New Password</label>
          <div className="relative">
            <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 6 characters"
              className="w-full pl-11 pr-11 py-3 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPw(!showPw)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition p-0.5"
              tabIndex={-1}
            >
              {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-400 mb-1.5 block">Confirm Password</label>
          <div className="relative">
            <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type={showPw ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Re-enter password"
              className="w-full pl-11 pr-4 py-3 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
              autoComplete="new-password"
            />
          </div>
        </div>

        {err && <p className="text-red-500 text-xs bg-red-500/10 px-3 py-2 rounded-lg">{err}</p>}

        <button
          type="submit"
          disabled={busy || !sessionReady}
          className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold rounded-xl flex items-center justify-center gap-2 transition"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Update Password'}
        </button>
      </form>
    </div>
  )
}
