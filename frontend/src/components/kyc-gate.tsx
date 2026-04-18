'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase'
import Logo from './logo'
import { Shield, Loader2, AlertCircle, CreditCard } from 'lucide-react'

interface Props {
  userId: string
  kycStatus: string
  onRefresh: () => void
}

export default function KycGate({ userId, kycStatus, onRefresh }: Props) {
  const [kycType, setKycType] = useState<'bvn' | 'nin'>('bvn')
  const [idNumber, setIdNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [submitted, setSubmitted] = useState(kycStatus === 'submitted')

  const supabase = createClient()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')

    if (idNumber.length !== 11) {
      setErr(kycType === 'bvn' ? 'BVN must be 11 digits' : 'NIN must be 11 digits')
      return
    }
    if (!/^\d+$/.test(idNumber)) { setErr('Enter digits only'); return }

    setBusy(true)

    // Hash the ID for privacy
    const encoder = new TextEncoder()
    const data = encoder.encode(idNumber)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const idHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')

    const { error } = await supabase.rpc('submit_kyc', {
      p_user_id: userId,
      p_kyc_type: kycType,
      p_kyc_id_hash: idHash,
    })

    if (error) {
      setErr(error.message)
      setBusy(false)
    } else {
      setSubmitted(true)
      setBusy(false)
      // Auto-refresh after short delay (status becomes 'verified' immediately in demo)
      setTimeout(onRefresh, 1500)
    }
  }

  if (submitted || kycStatus === 'submitted') {
    return (
      <div className="min-h-dvh bg-slate-50 flex flex-col items-center justify-center px-6">
        <Logo size={48} className="mb-4" />
        <AlertCircle className="w-12 h-12 text-amber-500 mb-4" />
        <h1 className="text-xl font-bold text-slate-900 mb-2">Verification In Progress</h1>
        <p className="text-slate-500 text-sm text-center max-w-xs mb-6">
          Your identity verification is being processed. This usually takes a moment.
        </p>
        <button
          onClick={onRefresh}
          className="text-sm font-semibold text-emerald-600 bg-emerald-50 px-4 py-2.5 rounded-xl hover:bg-emerald-100 transition"
        >
          Check Status
        </button>
      </div>
    )
  }

  if (kycStatus === 'rejected') {
    return (
      <div className="min-h-dvh bg-slate-50 flex flex-col items-center justify-center px-6">
        <Logo size={48} className="mb-4" />
        <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
        <h1 className="text-xl font-bold text-slate-900 mb-2">Verification Failed</h1>
        <p className="text-slate-500 text-sm text-center max-w-xs mb-6">
          Your verification was not approved. Please try again with correct details.
        </p>
        <button
          onClick={() => {
            setSubmitted(false)
            setIdNumber('')
            setErr('')
          }}
          className="text-sm font-semibold text-emerald-600 bg-emerald-50 px-4 py-2.5 rounded-xl hover:bg-emerald-100 transition"
        >
          Try Again
        </button>
      </div>
    )
  }

  // Pending — show verification form
  return (
    <div className="min-h-dvh bg-slate-50 flex flex-col safe-top safe-bottom">
      <div className="flex-1 flex flex-col items-center justify-center px-6 pt-12 pb-8">
        <Logo size={48} className="mb-4" />
        <Shield className="w-10 h-10 text-emerald-600 mb-3" />
        <h1 className="text-xl font-bold text-slate-900 mb-1">Verify Your Identity</h1>
        <p className="text-slate-500 text-sm text-center max-w-xs mb-8">
          Complete KYC verification to secure your account and start transacting.
        </p>

        <form onSubmit={submit} className="w-full max-w-sm space-y-4">
          <div>
            <label className="text-xs font-medium text-slate-500 mb-2 block">ID Type</label>
            <div className="flex bg-slate-100 rounded-xl p-1">
              <button
                type="button"
                onClick={() => setKycType('bvn')}
                className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${
                  kycType === 'bvn' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'
                }`}
              >
                BVN
              </button>
              <button
                type="button"
                onClick={() => setKycType('nin')}
                className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${
                  kycType === 'nin' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'
                }`}
              >
                NIN
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-500 mb-1.5 block">
              {kycType === 'bvn' ? 'Bank Verification Number' : 'National Identity Number'}
            </label>
            <div className="relative">
              <CreditCard className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                inputMode="numeric"
                maxLength={11}
                value={idNumber}
                onChange={(e) => setIdNumber(e.target.value.replace(/\D/g, ''))}
                placeholder={kycType === 'bvn' ? '22012345678' : '10012345678'}
                className="w-full pl-11 pr-4 py-3 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <p className="text-xs text-slate-400 mt-1">
              {kycType === 'bvn' ? '11-digit BVN from your bank' : '11-digit NIN from NIMC'}
            </p>
          </div>

          {err && <p className="text-red-600 text-xs bg-red-50 px-3 py-2 rounded-lg">{err}</p>}

          <button
            type="submit"
            disabled={busy || idNumber.length !== 11}
            className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98]"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : (
              <>
                <Shield className="w-4 h-4" />
                Submit Verification
              </>
            )}
          </button>
        </form>

        <p className="text-xs text-slate-400 mt-6 text-center max-w-xs">
          Your ID is encrypted and stored securely. We never share your personal data.
        </p>
      </div>
    </div>
  )
}
