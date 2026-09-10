'use client'

import { useState, useEffect } from 'react'
import { useAuth, useProfile, useWallet, useTransactions } from '@/hooks/use-data'
import HomeView from './home-view'
import GroupsView from './groups-view'
import SaveView from './save-view'
import InvestView from './invest-view'
import BorrowView from './borrow-view'
import ProfileView from './profile-view'
import BiometricLock from './biometric-lock'
import PinSetup from './pin-setup'
import KycGate from './kyc-gate'
import { isAppLockEnabled } from '@/lib/app-lock'

type Tab = 'home' | 'save' | 'ajo' | 'invest' | 'borrow' | 'profile'

const NavHome = (p: any) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 10l9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
const NavSave = (p: any) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18"/></svg>
const NavAjo = (p: any) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
const NavInvest = (p: any) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 17l6-6 4 4 8-8"/><path d="M17 7h4v4"/></svg>
const NavBorrow = (p: any) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
const NavProfile = (p: any) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>

const tabs: { id: Tab; label: string; Icon: React.FC<any> }[] = [
  { id: 'home',    label: 'Home',    Icon: NavHome },
  { id: 'save',    label: 'Save',    Icon: NavSave },
  { id: 'ajo',     label: 'Ajo',     Icon: NavAjo },
  { id: 'invest',  label: 'Invest',  Icon: NavInvest },
  { id: 'borrow',  label: 'Borrow',  Icon: NavBorrow },
  { id: 'profile', label: 'Profile', Icon: NavProfile },
]

type ThemePref = 'system' | 'light' | 'dark'

export default function AppShell() {
  const { user, signOut } = useAuth()
  const { profile, refresh: refreshProfile } = useProfile()
  const { wallet, refresh: refreshWallet } = useWallet()
  const { transactions, refresh: refreshTx } = useTransactions()
  const [tab, setTab] = useState<Tab>('home')
  const [showKycGate, setShowKycGate] = useState(false)
  const [theme, setTheme] = useState<ThemePref>('system')
  const [locked, setLocked] = useState(false)

  // Refresh the profile too — onboarding state (strails_onboard_status, the NUBAN)
  // and KYC live there, so a BVN submit / account arrival must re-read it or the UI
  // never advances past the form (this is why a new user's BVN "did nothing").
  const refresh = async () => { await Promise.all([refreshWallet(), refreshTx(), refreshProfile()]) }

  // One-time welcome email (universal — Google + email signups). Idempotent on the
  // server via the welcome_sent flag; safe to call on every load.
  useEffect(() => {
    if (user?.id) fetch('/api/welcome', { method: 'POST' }).catch(() => {})
  }, [user?.id])

  // Biometric app-lock: lock on launch if enabled, and re-lock when the app is
  // backgrounded so returning to it requires Face ID / fingerprint again.
  useEffect(() => {
    if (user?.id && isAppLockEnabled(user.id)) setLocked(true)
  }, [user?.id])
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden' && user?.id && isAppLockEnabled(user.id)) setLocked(true) }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [user?.id])

  // A deposit/withdrawal settles a few seconds after it's initiated, but the app
  // wouldn't re-fetch, so it sat on "Pending" until a manual reload. Poll while any
  // deposit/withdrawal is still pending and stop once everything has resolved.
  const hasPendingRamp = transactions.some(
    (t) => t.status === 'pending' && (t.type === 'deposit' || t.type === 'withdrawal'),
  )
  useEffect(() => {
    if (!hasPendingRamp) return
    // Only poll while the tab is actually visible — a backgrounded tab waiting on a
    // pending settle shouldn't keep hitting the API (saves invocations/bandwidth).
    const id = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 8000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPendingRamp])

  if (showKycGate && profile) {
    return (
      <KycGate
        userId={user?.id || ''}
        kycStatus={profile.kyc_status || 'pending'}
        onRefresh={() => {
          refreshProfile()
          setShowKycGate(false)
        }}
      />
    )
  }

  // Mandatory PIN setup for any signed-in user without a transaction PIN (e.g. Google
  // sign-ups). Users who set a PIN at email sign-up already have one → never shown.
  if (profile && !profile.transaction_pin_hash) {
    return <PinSetup email={user?.email} onDone={refreshProfile} />
  }

  const dataTheme = theme === 'system' ? undefined : theme

  return (
    <div className="ps flex flex-col safe-top" data-theme={dataTheme}>
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto">
          {tab === 'home' && (
            <HomeView
              wallet={wallet}
              transactions={transactions}
              user={user}
              refresh={refresh}
              profile={profile}
              onStartKyc={() => setShowKycGate(true)}
              onNavigateVault={() => setTab('save')}
            />
          )}
          {tab === 'save' && <SaveView wallet={wallet} refresh={refresh} />}
          {tab === 'ajo' && <GroupsView user={user} wallet={wallet} />}
          {tab === 'invest' && <InvestView wallet={wallet} profile={profile} refresh={refresh} onStartKyc={() => setShowKycGate(true)} />}
          {tab === 'borrow' && <BorrowView wallet={wallet} refresh={refresh} />}
          {tab === 'profile' && (
            <ProfileView
              user={user}
              profile={profile}
              wallet={wallet}
              theme={theme}
              onThemeChange={setTheme}
              onRefreshProfile={refreshProfile}
              onStartKyc={() => setShowKycGate(true)}
              onSignOut={signOut}
            />
          )}
        </div>
      </main>

      <nav className="nav">
        {tabs.map(({ id, label, Icon }) => (
          <button key={id} onClick={() => setTab(id)} className={tab === id ? 'on' : ''}>
            <Icon />
            {label}
          </button>
        ))}
      </nav>

      {locked && user && <BiometricLock userId={user.id} onUnlock={() => setLocked(false)} />}
    </div>
  )
}