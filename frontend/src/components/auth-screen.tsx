'use client'

import { useState } from 'react'
import { useAuth } from '@/hooks/use-data'
import Logo from '@/components/logo'
import { Mail, Lock, User, ArrowRight, Loader2, Eye, EyeOff, ArrowLeft } from 'lucide-react'

export default function AuthScreen() {
  const { signUp, signIn, resetPassword } = useAuth()
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [resetSent, setResetSent] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')

    if (!email.includes('@')) { setErr('Enter a valid email address'); return }

    if (mode === 'forgot') {
      setBusy(true)
      try {
        await resetPassword(email)
        setResetSent(true)
      } catch (e: any) {
        setErr(e.message || 'Something went wrong')
      } finally {
        setBusy(false)
      }
      return
    }

    if (password.length < 6) { setErr('Password must be at least 6 characters'); return }

    setBusy(true)
    try {
      if (mode === 'register') {
        await signUp(email, password, name || email.split('@')[0])
      } else {
        await signIn(email, password)
      }
    } catch (e: any) {
      setErr(e.message || 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-dvh bg-slate-950 flex flex-col safe-top safe-bottom">
      <div className="flex-1 flex flex-col items-center justify-center px-6 pt-16 pb-8">
        <Logo size={56} className="mb-5" />
        <h1 className="text-3xl font-bold text-white tracking-tight">PawaSave</h1>
        <p className="text-slate-400 mt-2 text-center text-sm leading-relaxed max-w-xs">
          Collect naira. Save in dollars.<br />Withdraw anytime. For everyone.
        </p>
      </div>

      <div className="bg-white rounded-t-3xl px-6 pt-8 pb-10">
        {mode === 'forgot' ? (
          <>
            <button
              onClick={() => { setMode('login'); setErr(''); setResetSent(false) }}
              className="flex items-center gap-1 text-sm text-slate-500 mb-4"
            >
              <ArrowLeft className="w-4 h-4" /> Back to Sign In
            </button>
            <h2 className="text-lg font-bold text-slate-900 mb-1">Forgot Password</h2>
            <p className="text-sm text-slate-400 mb-6">Enter your email and we&apos;ll send a reset link.</p>

            {resetSent ? (
              <div className="bg-emerald-50 text-emerald-700 px-4 py-3 rounded-xl text-sm font-medium">
                Reset link sent! Check your email inbox.
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-slate-500 mb-1.5 block">Email</label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@email.com"
                      className="w-full pl-11 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      autoComplete="email"
                    />
                  </div>
                </div>
                {err && <p className="text-red-600 text-xs bg-red-50 px-3 py-2 rounded-lg">{err}</p>}
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98]"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send Reset Link'}
                </button>
              </form>
            )}
          </>
        ) : (
          <>
            <div className="flex bg-slate-100 rounded-xl p-1 mb-6">
              <button
                onClick={() => { setMode('register'); setErr('') }}
                className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${
                  mode === 'register' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                }`}
              >
                Create Account
              </button>
              <button
                onClick={() => { setMode('login'); setErr('') }}
                className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${
                  mode === 'login' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                }`}
              >
                Sign In
              </button>
            </div>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1.5 block">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@email.com"
                    className="w-full pl-11 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    autoComplete="email"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-slate-500">Password</label>
                  {mode === 'login' && (
                    <button
                      type="button"
                      onClick={() => { setMode('forgot'); setErr('') }}
                      className="text-xs font-medium text-emerald-600 hover:text-emerald-700 transition"
                    >
                      Forgot Password?
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type={showPw ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min 6 characters"
                    className="w-full pl-11 pr-11 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(!showPw)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition p-0.5"
                    tabIndex={-1}
                  >
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {mode === 'register' && (
                <div>
                  <label className="text-xs font-medium text-slate-500 mb-1.5 block">Your name</label>
                  <div className="relative">
                    <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Chidi Okafor"
                      className="w-full pl-11 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                </div>
              )}

              {err && <p className="text-red-600 text-xs bg-red-50 px-3 py-2 rounded-lg">{err}</p>}

              <button
                type="submit"
                disabled={busy}
                className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98]"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                  <>
                    {mode === 'register' ? 'Get Started' : 'Sign In'}
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          </>
        )}

        <p className="text-center text-xs text-slate-400 mt-6">
          Powered by Supabase &middot; FlintAPI &middot; Base L2
        </p>
      </div>
    </div>
  )
}
