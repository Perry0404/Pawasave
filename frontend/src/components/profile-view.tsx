'use client'

import { useState, useEffect } from 'react'
// User aliased: `User` here is already the Supabase auth type.
import { CaretRight, User as UserIcon, CreditCard, Lock, Bell, Question, Check, Storefront } from '@phosphor-icons/react'
import PawaHub from './pawa-hub'
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
  const [open, setOpen] = useState<null | 'pin' | 'bank' | 'personal' | 'support' | 'tag' | 'sell'>(null)

  // PIN change (server-verified via /api/security/pin — current PIN required when set)
  const [pin, setPin] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [pinCurrent, setPinCurrent] = useState('')
  const [pinMsg, setPinMsg] = useState('')

  // PawaSave @tag (the P2P handle)
  const [tagInput, setTagInput] = useState('')
  const [tagMsg, setTagMsg] = useState('')
  const [tagBusy, setTagBusy] = useState(false)

  const saveTag = async () => {
    setTagMsg('')
    const t = tagInput.replace(/^@+/, '').trim().toLowerCase()
    if (!/^[a-z0-9_]{3,20}$/.test(t)) { setTagMsg('3–20 letters, numbers or underscores'); return }
    setTagBusy(true)
    try {
      const res = await fetch('/api/p2p/tag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: t }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setTagMsg(data?.error || 'Could not update tag'); return }
      setTagMsg('Tag updated ✓')
      onRefreshProfile?.()
    } catch {
      setTagMsg('Could not update tag')
    } finally {
      setTagBusy(false)
    }
  }

  // Pay with Pawa — buyer/orders hub (§3.6) + seller mode + payment links
  const [showPawa, setShowPawa] = useState(false)
  const [sellName, setSellName] = useState('')
  const [sellEnabled, setSellEnabled] = useState(false)
  const [sellMsg, setSellMsg] = useState('')
  const [sellBusy, setSellBusy] = useState(false)
  const [linkAmount, setLinkAmount] = useState('')
  const [linkNote, setLinkNote] = useState('')
  const [linkEscrow, setLinkEscrow] = useState(true)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkCopied, setLinkCopied] = useState(false)

  const openSell = () => {
    setSellMsg(''); setLinkUrl(''); setLinkCopied(false)
    fetch('/api/pawa/merchant').then((r) => r.json()).then((d) => {
      setSellEnabled(Boolean(d?.enabled)); setSellName(d?.merchantName || '')
    }).catch(() => {})
    toggle('sell')
  }

  const saveMerchant = async (enabled: boolean) => {
    setSellMsg(''); setSellBusy(true)
    try {
      const res = await fetch('/api/pawa/merchant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, merchantName: sellName || undefined }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setSellMsg(d?.error || 'Could not update'); return }
      setSellEnabled(enabled); setSellMsg('Saved ✓')
    } catch { setSellMsg('Could not update') } finally { setSellBusy(false) }
  }

  const createLink = async () => {
    setSellMsg(''); setLinkUrl(''); setLinkCopied(false)
    const amt = Number(linkAmount)
    if (!(amt >= 100)) { setSellMsg('Enter an amount (min ₦100)'); return }
    setSellBusy(true)
    try {
      const res = await fetch('/api/pawa/link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountNgn: amt, note: linkNote || undefined, escrow: linkEscrow }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setSellMsg(d?.error || 'Could not create link'); return }
      setLinkUrl(d.url)
    } catch { setSellMsg('Could not create link') } finally { setSellBusy(false) }
  }

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(linkUrl); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000) } catch { /* clipboard blocked */ }
  }

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

  const toggle = (k: 'pin' | 'bank' | 'personal' | 'support' | 'tag' | 'sell') => setOpen(open === k ? null : k)

  if (showPawa) return <PawaHub onBack={() => setShowPawa(false)} />

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

        <button className="row" onClick={() => { setTagInput(p?.tag || ''); setTagMsg(''); toggle('tag') }}>
          <span className="dot"><IconUser /></span>
          <div className="mid"><div className="nm">PawaSave tag</div><div className="sub">{p?.tag ? '@' + p.tag : 'Set your @tag'}</div></div>
          <span className="chev"><Chevron /></span>
        </button>
        {open === 'tag' && (
          <div style={{ padding: '4px 15px 15px', borderTop: '1px solid var(--line)' }}>
            <p className="p" style={{ margin: '10px 0 6px' }}>People can send you money instantly with your @tag — no bank details or email needed.</p>
            <label className="lab">Your tag</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 'var(--w-semi)', color: 'var(--muted)' }}>@</span>
              <input
                className="field"
                type="text"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={20}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase())}
                placeholder="yourname"
              />
            </div>
            {tagMsg && <p className="hint tight" style={{ color: tagMsg.includes('✓') ? 'var(--green)' : 'var(--neg)', marginTop: 6 }}>{tagMsg}</p>}
            <button className="cta" onClick={saveTag} disabled={tagBusy || !tagInput.trim()} style={{ marginTop: 10 }}>{tagBusy ? 'Saving…' : 'Save tag'}</button>
          </div>
        )}

        <button className="row" onClick={() => setShowPawa(true)}>
          <span className="dot"><Storefront /></span>
          <div className="mid"><div className="nm">Pay with Pawa</div><div className="sub">Pay a seller & track your orders</div></div>
          <span className="chev"><Chevron /></span>
        </button>

        <button className="row" onClick={openSell}>
          <span className="dot"><CreditCard /></span>
          <div className="mid"><div className="nm">Sell with Pawa</div><div className="sub">{p?.tag ? `Get paid at @${p.tag}` : 'Set a @tag to sell'}</div></div>
          <span className="chev"><Chevron /></span>
        </button>
        {open === 'sell' && (
          <div style={{ padding: '4px 15px 15px', borderTop: '1px solid var(--line)' }}>
            {!p?.tag ? (
              <p className="p" style={{ margin: '10px 0' }}>Set your PawaSave @tag first — it becomes your Pawa Tag, the handle buyers pay.</p>
            ) : (
              <>
                <p className="p" style={{ margin: '10px 0 6px' }}>Take payments at <b>@{p.tag}</b>. Share a payment link in a DM, or let buyers pay your tag. Money is held in escrow until the buyer confirms — so no more “send proof of payment”.</p>

                <label className="lab">Store name (optional)</label>
                <input className="field" type="text" maxLength={60} value={sellName} onChange={(e) => setSellName(e.target.value)} placeholder="e.g. Adaeze Fashions" />
                <button className="cta" onClick={() => saveMerchant(true)} disabled={sellBusy} style={{ marginTop: 10 }}>
                  {sellBusy ? 'Saving…' : sellEnabled ? 'Update store' : 'Turn on selling'}
                </button>

                <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
                  <label className="lab">Create a payment link</label>
                  <input className="field" type="number" inputMode="decimal" value={linkAmount} onChange={(e) => setLinkAmount(e.target.value)} placeholder="Amount (₦)" style={{ marginTop: 4 }} />
                  <input className="field" type="text" maxLength={200} value={linkNote} onChange={(e) => setLinkNote(e.target.value)} placeholder="What's it for? (optional)" style={{ marginTop: 8 }} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 13 }}>
                    <input type="checkbox" checked={linkEscrow} onChange={(e) => setLinkEscrow(e.target.checked)} />
                    Hold in escrow until the buyer confirms delivery
                  </label>
                  <button className="cta" onClick={createLink} disabled={sellBusy} style={{ marginTop: 10 }}>{sellBusy ? 'Creating…' : 'Create link'}</button>

                  {linkUrl && (
                    <div style={{ marginTop: 12, background: 'var(--card-2, #f3f6f4)', borderRadius: 12, padding: 12 }}>
                      <p className="hint tight" style={{ wordBreak: 'break-all', marginBottom: 8 }}>{linkUrl}</p>
                      <button className="cta" onClick={copyLink}>{linkCopied ? 'Copied ✓' : 'Copy link'}</button>
                    </div>
                  )}
                </div>
              </>
            )}
            {sellMsg && <p className="hint tight" style={{ color: sellMsg.includes('✓') ? 'var(--green)' : 'var(--neg)', marginTop: 8 }}>{sellMsg}</p>}
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