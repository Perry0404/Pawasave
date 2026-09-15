'use client'

import { useState, useEffect } from 'react'
// User aliased: `User` here is already the Supabase auth type.
import { CaretRight, User as UserIcon, CreditCard, Lock, Bell, Question, Check } from '@phosphor-icons/react'
import type { User } from '@supabase/supabase-js'
import type { Profile, Wallet } from '@/lib/types'
import { useConfirm } from '@/components/confirm-dialog'
import { isBiometricAvailable, isAppLockEnabled, enableAppLock, disableAppLock } from '@/lib/app-lock'
import { isPushEnabled, enablePush, disablePush } from '@/lib/notifications'

type ThemePref = 'system' | 'light' | 'dark'

interface Props {
  user: User | null
  profile: Profile | null
  wallet: Wallet | null
  theme: ThemePref
  onThemeChange: (t: ThemePref) => void
  onRefreshProfile: () => void
  onStartKyc: () => void
  onSignOut: () => void
}

const Chevron = () => <CaretRight />
const IconUser = () => <UserIcon />
const IconBank = () => <CreditCard />
const IconLock = () => <Lock />
const IconBell = () => <Bell />
const IconHelp = () => <Question />
const IconCheck = () => <Check size={12} weight="bold" />

export default function ProfileView({ user, profile, wallet, theme, onThemeChange, onRefreshProfile, onStartKyc, onSignOut }: Props) {
  const confirm = useConfirm()
  const [open, setOpen] = useState<null | 'pin' | 'bank' | 'personal' | 'support'>(null)

  // PIN change (server-verified via /api/security/pin — current PIN required when set)
  const [pin, setPin] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [pinCurrent, setPinCurrent] = useState('')
  const [pinMsg, setPinMsg] = useState('')

  // Support
  const [supportMessage, setSupportMessage] = useState('')

  // App lock (biometric) + notifications — device-local toggles
  const [bioAvail, setBioAvail] = useState(false)
  const [bioOn, setBioOn] = useState(false)
  const [pushOn, setPushOn] = useState(false)
  const [secMsg, setSecMsg] = useState('')

  useEffect(() => {
    isBiometricAvailable().then(setBioAvail)
    if (user?.id) setBioOn(isAppLockEnabled(user.id))
    setPushOn(isPushEnabled())
  }, [user?.id])

  const toggleBio = async () => {
    if (!user?.id) return
    setSecMsg('')
    if (bioOn) { disableAppLock(user.id); setBioOn(false); setSecMsg('App lock turned off'); return }
    const ok = await enableAppLock(user.id, user.email || 'PawaSave')
    if (ok) { setBioOn(true); setSecMsg('App lock on — Face ID / fingerprint required to open') }
    else setSecMsg('Could not set up biometric lock on this device')
  }

  const togglePush = async () => {
    setSecMsg('')
    if (pushOn) { await disablePush(); setPushOn(false); setSecMsg('Notifications turned off'); return }
    const res = await enablePush()
    if (res.ok) { setPushOn(true); setSecMsg('Notifications on') }
    else setSecMsg(res.message || 'Could not enable notifications')
  }

  const p = profile as any
  const name = profile?.display_name || user?.email?.split('@')[0] || 'PawaSave user'
  const initials = name.split(' ').map((s: string) => s[0]).join('').slice(0, 2).toUpperCase()
  const verified = profile?.kyc_status === 'verified'
  // KYC (Sense) is only offered when subscribed; until then everyone is tier 1.
  const kycAvailable = process.env.NEXT_PUBLIC_KYC_ENABLED === 'true'
  const acct = p?.strails_va_account_number as string | undefined

  const savePin = async () => {
    if (!/^\d{4}$/.test(pin)) { setPinMsg('PIN must be exactly 4 digits'); return }
    if (pin !== pinConfirm) { setPinMsg('PINs do not match'); return }
    try {
      const res = await fetch('/api/security/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPin: pin, currentPin: pinCurrent || undefined }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || 'Failed to update PIN')
      await onRefreshProfile()
      setPin(''); setPinConfirm(''); setPinCurrent('')
      setPinMsg('Transaction PIN updated ✓')
    } catch (e: any) {
      setPinMsg(e?.message || 'Failed to update PIN')
    }
  }

  const toggle = (k: 'pin' | 'bank' | 'personal' | 'support') => setOpen(open === k ? null : k)

  return (
    <div className="b">
      {/* Header */}
      <div className="prof">
        <div className="pav">{initials}</div>
        <div className="pn">{name}</div>
        <div className="pe">{user?.email}</div>
        {verified ? (
          <span className="badge ok"><IconCheck /> KYC Verified</span>
        ) : kycAvailable ? (
          <span className="badge warn" onClick={onStartKyc} style={{ cursor: 'pointer' }}>Verify your account →</span>
        ) : (
          <span className="badge warn">Tier 1 · ₦20,000 limit</span>
        )}
      </div>

      {/* Account */}
      <div className="sect"><span className="h">Account</span></div>
      <div className="rows">
        <button className="row" onClick={() => toggle('personal')}>
          <span className="dot"><IconUser /></span>
          <div className="mid"><div className="nm">Personal details</div><div className="sub">{user?.email}</div></div>
          <span className="chev"><Chevron /></span>
        </button>
        {open === 'personal' && (
          <div style={{ padding: '2px 15px 14px', borderTop: '1px solid var(--line)' }}>
            <p className="p" style={{ margin: '10px 0 0' }}>Name: {name}</p>
            <p className="p" style={{ margin: '2px 0 0' }}>KYC: {profile?.kyc_status || 'pending'}</p>
            {!verified && kycAvailable && <button className="cta" onClick={onStartKyc} style={{ marginTop: 10 }}>Verify identity</button>}
          </div>
        )}

        <button className="row" onClick={() => toggle('bank')}>
          <span className="dot"><IconBank /></span>
          <div className="mid">
            <div className="nm">Bank account</div>
            <div className="sub">{acct ? `${p?.strails_va_bank_name || 'NUBAN'} · ${acct}` : 'No account yet'}</div>
          </div>
          <span className="chev"><Chevron /></span>
        </button>
        {open === 'bank' && (
          <div style={{ padding: '2px 15px 14px', borderTop: '1px solid var(--line)' }}>
            {acct ? (
              <div className="info" style={{ marginTop: 10 }}>
                <div className="l">Account number</div>
                <div className="code" style={{ fontSize: 18, marginTop: 2 }}>{acct}</div>
                <div className="l" style={{ marginTop: 8 }}>Bank</div>
                <div className="code" style={{ fontSize: 13 }}>{p?.strails_va_bank_name}</div>
                <div className="l" style={{ marginTop: 8 }}>Account name</div>
                <div className="code" style={{ fontSize: 13 }}>{p?.strails_va_account_name}</div>
              </div>
            ) : (
              <p className="p" style={{ margin: '10px 0 0' }}>Get a dedicated Naira account from the Receive screen on Home.</p>
            )}
          </div>
        )}

        <button className="row" onClick={() => toggle('pin')}>
          <span className="dot"><IconLock /></span>
          <div className="mid"><div className="nm">Transaction PIN</div><div className="sub">{profile?.transaction_pin_hash ? 'Change your 4-digit PIN' : 'Set your 4-digit PIN'}</div></div>
          <span className="chev"><Chevron /></span>
        </button>
        {open === 'pin' && (
          <div style={{ padding: '4px 15px 15px', borderTop: '1px solid var(--line)' }}>
            {profile?.transaction_pin_hash && (
              <>
                <label className="lab" style={{ marginTop: 12 }}>Current PIN</label>
                <input className="field" type="password" inputMode="numeric" maxLength={4} value={pinCurrent}
                  onChange={(e) => setPinCurrent(e.target.value.replace(/\D/g, ''))} placeholder="••••" />
              </>
            )}
            <label className="lab" style={{ marginTop: 12 }}>New PIN</label>
            <input className="field" type="password" inputMode="numeric" maxLength={4} value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" />
            <label className="lab" style={{ marginTop: 12 }}>Repeat new PIN</label>
            <input className="field" type="password" inputMode="numeric" maxLength={4} value={pinConfirm}
              onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ''))} placeholder="••••" />
            {pinMsg && <div className={`flash ${pinMsg.includes('✓') ? 'ok' : 'err'}`}>{pinMsg}</div>}
            <button className="cta" onClick={savePin}>Save PIN</button>
          </div>
        )}
      </div>

      {/* App */}
      <div className="sect"><span className="h">App</span></div>
      <div className="rows">
        <div className="row" style={{ cursor: 'default' }}>
          <span className="dot"><IconBell /></span>
          <div className="mid"><div className="nm">Appearance</div><div className="sub">Theme for this device</div></div>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button key={t} onClick={() => onThemeChange(t)}
                className="term"
                style={theme === t ? { background: 'var(--green)', color: '#fff', borderColor: 'var(--green)', padding: '6px 10px' } : { padding: '6px 10px' }}>
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="row" style={{ cursor: 'default' }}>
          <span className="dot"><IconLock /></span>
          <div className="mid"><div className="nm">App lock</div><div className="sub">{bioAvail ? 'Face ID / fingerprint to open the app' : 'Not available on this device'}</div></div>
          <button className="term" onClick={toggleBio} disabled={!bioAvail}
            style={bioOn ? { background: 'var(--green)', color: '#fff', borderColor: 'var(--green)', padding: '6px 14px' } : { padding: '6px 14px' }}>
            {bioOn ? 'On' : 'Off'}
          </button>
        </div>

        <div className="row" style={{ cursor: 'default' }}>
          <span className="dot"><IconBell /></span>
          <div className="mid"><div className="nm">Notifications</div><div className="sub">Deposits, Ajo payouts &amp; loan reminders</div></div>
          <button className="term" onClick={togglePush}
            style={pushOn ? { background: 'var(--green)', color: '#fff', borderColor: 'var(--green)', padding: '6px 14px' } : { padding: '6px 14px' }}>
            {pushOn ? 'On' : 'Off'}
          </button>
        </div>

        <button className="row" onClick={() => toggle('support')}>
          <span className="dot"><IconHelp /></span>
          <div className="mid"><div className="nm">Help &amp; support</div><div className="sub">Chat with us or send an email</div></div>
          <span className="chev"><Chevron /></span>
        </button>
        {open === 'support' && (
          <div style={{ padding: '4px 15px 15px', borderTop: '1px solid var(--line)' }}>
            <label className="lab" style={{ marginTop: 12 }}>What do you need help with?</label>
            <textarea className="field" rows={3} value={supportMessage}
              onChange={(e) => setSupportMessage(e.target.value)}
              placeholder="Deposits, withdrawals, KYC, PIN…" style={{ resize: 'none' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              <a className="cta" style={{ marginTop: 0, textAlign: 'center', textDecoration: 'none', display: 'block' }}
                href={`https://wa.me/2348067117651?text=${encodeURIComponent(`Hi PawaSave support! My account: ${user?.email || ''}\n\nIssue: ${supportMessage || '(no description)'}`)}`}
                target="_blank" rel="noopener noreferrer">WhatsApp support</a>
              <a className="cta ghost" style={{ marginTop: 0, color: 'var(--green)', textAlign: 'center', textDecoration: 'none', display: 'block' }}
                href={`mailto:support@pawasave.xyz?subject=Support Request&body=Account: ${user?.email || ''}\n\n${supportMessage || ''}`}>Email support</a>
            </div>
          </div>
        )}
      </div>

      {secMsg && <div className="flash ok">{secMsg}</div>}

      <button
        className="cta ghost"
        style={{ marginTop: 16 }}
        onClick={async () => { if (await confirm({ title: 'Log out', message: 'Log out of PawaSave?', confirmText: 'Log out' })) onSignOut() }}
      >
        Log out
      </button>
    </div>
  )
}