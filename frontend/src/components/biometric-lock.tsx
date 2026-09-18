'use client'

import { useEffect, useState } from 'react'
import { verifyAppLock } from '@/lib/app-lock'

/** Full-screen biometric gate shown over the app when the lock is enabled. */
export default function BiometricLock({ userId, onUnlock }: { userId: string; onUnlock: () => void }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const attempt = async () => {
    setBusy(true); setFailed(false)
    const ok = await verifyAppLock(userId)
    setBusy(false)
    if (ok) onUnlock(); else setFailed(true)
  }

  // Auto-prompt once on mount.
  useEffect(() => { attempt() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

  return (
    <div className="ps" style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'grid', placeItems: 'center', background: 'var(--bg)', padding: 24 }}>
      <div style={{ textAlign: 'center', maxWidth: 300 }}>
        <div style={{ width: 62, height: 62, borderRadius: '50%', border: '3px solid var(--green)', margin: '0 auto 20px', position: 'relative' }}>
          <span style={{ position: 'absolute', width: 14, height: 14, borderRadius: '50%', background: 'var(--green)', top: -3, left: '50%', transform: 'translateX(-50%)' }} />
        </div>
        <div style={{ fontSize: 18, fontWeight: 680, color: 'var(--ink)' }}>PawaSave is locked</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 20px' }}>
          {failed ? 'Could not verify. Try again to unlock.' : 'Unlock with your fingerprint or Face ID to continue.'}
        </p>
        <button className="cta" style={{ marginTop: 0 }} onClick={attempt} disabled={busy}>
          {busy ? 'Verifying…' : 'Unlock'}
        </button>
      </div>
    </div>
  )
}