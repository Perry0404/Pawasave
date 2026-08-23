'use client'

import { useState } from 'react'

/**
 * Mandatory transaction-PIN setup. Shown once, full-screen, to any logged-in user
 * who has no transaction_pin_hash yet — i.e. anyone who signed up with Google (or
 * otherwise never set a PIN). Users who chose a PIN at email sign-up already have
 * one and never see this. Writes via the secure /api/security/pin endpoint (no
 * current PIN required when none exists).
 */
export default function PinSetup({ email, onDone }: { email?: string | null; onDone: () => void }) {
  const [pin, setPin] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const save = async () => {
    setErr('')
    if (!/^\d{4}$/.test(pin)) { setErr('PIN must be exactly 4 digits'); return }
    if (pin !== confirm) { setErr('PINs do not match'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/security/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPin: pin }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || 'Could not set PIN')
      onDone()
    } catch (e: any) {
      setErr(e?.message || 'Could not set PIN')
      setBusy(false)
    }
  }

  return (
    <div className="ps" style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 360 }}>
        <div style={{ width: 56, height: 56, borderRadius: 16, margin: '0 auto 16px', display: 'grid', placeItems: 'center', background: 'var(--green-soft)', color: 'var(--green)' }}>
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
        </div>
        <div className="h2" style={{ textAlign: 'center', margin: '0 0 4px' }}>Create your transaction PIN</div>
        <p className="p" style={{ textAlign: 'center' }}>
          You&apos;ll use this 4-digit PIN to authorise withdrawals and loans. {email ? `Signed in as ${email}.` : ''}
        </p>

        <label className="lab" style={{ marginTop: 14 }}>New PIN</label>
        <input className="field" type="password" inputMode="numeric" maxLength={4} value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" autoFocus style={{ letterSpacing: '.35em' }} />

        <label className="lab" style={{ marginTop: 12 }}>Repeat PIN</label>
        <input className="field" type="password" inputMode="numeric" maxLength={4} value={confirm}
          onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))} placeholder="••••" style={{ letterSpacing: '.35em' }} />

        {err && <div className="flash err">{err}</div>}
        <button className="cta" onClick={save} disabled={busy || pin.length !== 4 || confirm.length !== 4}>
          {busy ? 'Saving…' : 'Set PIN & continue'}
        </button>
        <p className="p" style={{ textAlign: 'center', marginTop: 12, fontSize: 11 }}>
          Keep it secret. You can change it anytime in Profile.
        </p>
      </div>
    </div>
  )
}