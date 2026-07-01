'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import Logo from './logo'
import { Shield, Loader2, AlertCircle, CreditCard, CheckCircle2, UserRound, Calendar } from 'lucide-react'
import type { VerificationCaptureEngineProps } from '@usesense/web-sdk'

// Sense's biometric capture widget — camera + liveness. Client-only (uses
// getUserMedia / on-device models), so load it with ssr:false.
const VerificationCaptureEngine = dynamic<VerificationCaptureEngineProps>(
  () => import('@usesense/web-sdk').then((m) => ({ default: m.VerificationCaptureEngine })),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-emerald-600" />
      </div>
    ),
  },
)

interface Props {
  userId: string
  kycStatus: string
  onRefresh: () => void
}

type Step = 'form' | 'capture' | 'processing'

export default function KycGate({ userId, kycStatus, onRefresh }: Props) {
  const [step, setStep] = useState<Step>('form')
  const [kycType, setKycType] = useState<'bvn' | 'nin'>('bvn')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [dob, setDob] = useState('')
  const [idNumber, setIdNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [sessionData, setSessionData] = useState<VerificationCaptureEngineProps['sessionData'] | null>(null)
  const [environment, setEnvironment] = useState<'sandbox' | 'production'>('production')

  // When Sense finishes, the verdict lands on our webhook asynchronously. Poll
  // the profile so a verified user is let through without a manual refresh.
  useEffect(() => {
    if (step !== 'processing' && kycStatus !== 'submitted') return
    const t = setInterval(onRefresh, 5000)
    return () => clearInterval(t)
  }, [step, kycStatus, onRefresh])

  const start = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    if (firstName.trim().length < 2 || lastName.trim().length < 2) { setErr('Enter your first and last name as on your ID'); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) { setErr('Enter your date of birth'); return }
    if (idNumber.length !== 11) { setErr(kycType === 'bvn' ? 'BVN must be 11 digits' : 'NIN must be 11 digits'); return }

    setBusy(true)
    try {
      const res = await fetch('/api/kyc/create-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim(), dob, kycType, idNumber }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(data.error || 'Could not start verification'); return }
      setSessionData(data.sessionData)
      setEnvironment(data.environment === 'sandbox' ? 'sandbox' : 'production')
      setStep('capture')
    } catch {
      setErr('Network error — please try again')
    } finally {
      setBusy(false)
    }
  }

  // ── Rejected ────────────────────────────────────────────────────────────────
  if (kycStatus === 'rejected' && step === 'form') {
    return (
      <Shell>
        <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
        <h1 className="text-xl font-bold text-slate-900 mb-2">Verification Failed</h1>
        <p className="text-slate-500 text-sm text-center max-w-xs mb-6">
          We couldn’t confirm your identity. Please try again in good lighting, with your face clearly visible.
        </p>
        <button
          onClick={() => { setErr(''); setIdNumber(''); setStep('form'); }}
          className="text-sm font-semibold text-emerald-600 bg-emerald-50 px-4 py-2.5 rounded-xl hover:bg-emerald-100 transition"
        >
          Try Again
        </button>
      </Shell>
    )
  }

  // ── Processing (capture done, webhook finalizing) or server 'submitted' ──────
  if (step === 'processing' || kycStatus === 'submitted') {
    return (
      <Shell>
        <CheckCircle2 className="w-12 h-12 text-emerald-500 mb-4" />
        <h1 className="text-xl font-bold text-slate-900 mb-2">Verification Submitted</h1>
        <p className="text-slate-500 text-sm text-center max-w-xs mb-6">
          We’re confirming your identity — this usually takes a few seconds. You can continue; we’ll unlock withdrawals as soon as it’s approved.
        </p>
        <div className="flex items-center gap-2 text-emerald-600 mb-6"><Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm font-medium">Checking status…</span></div>
        <button onClick={onRefresh} className="text-sm font-semibold text-white bg-emerald-600 px-5 py-2.5 rounded-xl hover:bg-emerald-700 transition">
          Continue
        </button>
      </Shell>
    )
  }

  // ── Biometric capture (Sense) ────────────────────────────────────────────────
  if (step === 'capture' && sessionData) {
    return (
      <div className="min-h-dvh bg-slate-50 flex flex-col safe-top safe-bottom">
        <div className="px-5 pt-6 pb-2 text-center">
          <h1 className="text-lg font-bold text-slate-900">Face Verification</h1>
          <p className="text-xs text-slate-500 mt-1">Position your face in the frame and follow the prompts.</p>
        </div>
        <div className="flex-1 w-full max-w-md mx-auto" style={{ minHeight: 520 }}>
          <VerificationCaptureEngine
            sessionData={sessionData}
            environment={environment}
            displayName="PawaSave"
            primaryColor="#059669"
            sessionType="enrollment"
            onComplete={() => { setStep('processing') }}
            onError={(e: string) => { setErr(e || 'Verification failed — please try again'); setStep('form') }}
            onCancel={() => setStep('form')}
          />
        </div>
      </div>
    )
  }

  // ── Details form ─────────────────────────────────────────────────────────────
  return (
    <div className="min-h-dvh bg-slate-50 flex flex-col safe-top safe-bottom">
      <div className="flex-1 flex flex-col items-center justify-center px-6 pt-10 pb-8">
        <Logo size={44} className="mb-3" />
        <Shield className="w-9 h-9 text-emerald-600 mb-3" />
        <h1 className="text-xl font-bold text-slate-900 mb-1">Verify Your Identity</h1>
        <p className="text-slate-500 text-sm text-center max-w-xs mb-7">
          Confirm your details, then a quick face check. Required before withdrawals.
        </p>

        <form onSubmit={start} className="w-full max-w-sm space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1.5 block">First name</label>
              <div className="relative">
                <UserRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Ada"
                  className="w-full pl-9 pr-3 py-3 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1.5 block">Last name</label>
              <input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Okoro"
                className="w-full px-3 py-3 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-500 mb-1.5 block">Date of birth</label>
            <div className="relative">
              <Calendar className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} max={new Date().toISOString().slice(0, 10)}
                className="w-full pl-11 pr-4 py-3 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-500 mb-2 block">ID Type</label>
            <div className="flex bg-slate-100 rounded-xl p-1">
              {(['bvn', 'nin'] as const).map((t) => (
                <button type="button" key={t} onClick={() => setKycType(t)}
                  className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${kycType === t ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`}>
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-500 mb-1.5 block">
              {kycType === 'bvn' ? 'Bank Verification Number' : 'National Identity Number'}
            </label>
            <div className="relative">
              <CreditCard className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input type="text" inputMode="numeric" maxLength={11} value={idNumber}
                onChange={(e) => setIdNumber(e.target.value.replace(/\D/g, ''))}
                placeholder={kycType === 'bvn' ? '22012345678' : '10012345678'}
                className="w-full pl-11 pr-4 py-3 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <p className="text-xs text-slate-400 mt-1">{kycType === 'bvn' ? '11-digit BVN from your bank' : '11-digit NIN from NIMC'}</p>
          </div>

          {err && <p className="text-red-600 text-xs bg-red-50 px-3 py-2 rounded-lg">{err}</p>}

          <button type="submit" disabled={busy}
            className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98]">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Shield className="w-4 h-4" /> Continue to face check</>}
          </button>
        </form>

        <p className="text-xs text-slate-400 mt-6 text-center max-w-xs">
          Your ID is encrypted. The face check confirms a real, live person — nothing is shared.
        </p>
      </div>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-slate-50 flex flex-col items-center justify-center px-6 safe-top safe-bottom">
      <Logo size={48} className="mb-4" />
      {children}
    </div>
  )
}