'use client'

import { useState } from 'react'
import { useAuth, useProfile, useWallet, useTransactions } from '@/hooks/use-data'
import HomeView from './home-view'
import GroupsView from './groups-view'
import ActivityView from './activity-view'
import VaultView from './vault-view'
import KycGate from './kyc-gate'
import Logo from './logo'
import { Home, Users, Activity, LifeBuoy, Settings, LogOut, ShieldCheck, X, Vault } from 'lucide-react'

type Tab = 'home' | 'vault' | 'groups' | 'activity' | 'support' | 'settings'

const tabs: { id: Tab; label: string; Icon: React.FC<any> }[] = [
  { id: 'home', label: 'Home', Icon: Home },
  { id: 'vault', label: 'Save', Icon: Vault },
  { id: 'groups', label: 'Groups', Icon: Users },
  { id: 'activity', label: 'Activity', Icon: Activity },
  { id: 'support', label: 'Support', Icon: LifeBuoy },
  { id: 'settings', label: 'Settings', Icon: Settings },
]

export default function AppShell() {
  const { user, signOut } = useAuth()
  const { profile, refresh: refreshProfile } = useProfile()
  const { wallet, refresh: refreshWallet } = useWallet()
  const { transactions, refresh: refreshTx } = useTransactions()
  const [tab, setTab] = useState<Tab>('home')
  const [showKycReminder, setShowKycReminder] = useState(true)
  const [showKycGate, setShowKycGate] = useState(false)

  const [theme, setTheme] = useState<'mint' | 'ocean' | 'sunset'>('mint')
  const [supportMessage, setSupportMessage] = useState('')
  const [supportAiMode, setSupportAiMode] = useState(true)
  const [requestHuman, setRequestHuman] = useState(false)
  const [pin, setPin] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [settingsFeedback, setSettingsFeedback] = useState('')

  const refresh = () => { refreshWallet(); refreshTx() }

  const gradients = {
    mint: 'from-emerald-600 via-teal-700 to-slate-900',
    ocean: 'from-cyan-600 via-blue-700 to-slate-900',
    sunset: 'from-orange-500 via-rose-600 to-slate-900',
  }

  if (showKycGate && profile) {
    return (
      <KycGate
        userId={user?.id || ''}
        kycStatus={profile.kyc_status || 'pending'}
        onRefresh={() => {
          refreshProfile()
          setShowKycGate(false)
          setShowKycReminder(false)
        }}
      />
    )
  }

  const answerFaq = (q: string) => {
    const text = q.toLowerCase()
    if (text.includes('withdraw') && profile?.kyc_status !== 'verified') {
      return 'KYC is required before withdrawal. Open KYC from Home or Settings to continue.'
    }
    if (text.includes('deposit') || text.includes('receive')) {
      return 'Use Receive on Home, transfer using the instructions shown, then balance updates automatically.'
    }
    if (text.includes('pin')) {
      return 'Your 4-digit transaction PIN is required for withdrawals. You can update it in Settings.'
    }
    return 'I can help with deposits, withdrawals, KYC, and PIN security. If needed, request a human support handoff.'
  }

  const savePin = async () => {
    if (!/^\d{4}$/.test(pin)) {
      setSettingsFeedback('PIN must be exactly 4 digits')
      return
    }
    if (pin !== pinConfirm) {
      setSettingsFeedback('PINs do not match')
      return
    }
    try {
      const { updateTransactionPin } = await import('@/hooks/use-data')
      await updateTransactionPin(user?.id || '', pin)
      await refreshProfile()
      setPin('')
      setPinConfirm('')
      setSettingsFeedback('Transaction PIN updated successfully')
    } catch (e: any) {
      setSettingsFeedback(e?.message || 'Failed to update PIN')
    }
  }

  return (
    <div className={`min-h-dvh bg-gradient-to-br ${gradients[theme]} flex flex-col safe-top`}>
      {/* Header */}
      <header className="bg-black/30 backdrop-blur px-5 pt-4 pb-3 flex items-center justify-between sticky top-0 z-50 border-b border-white/10">
        <div className="flex items-center gap-2.5">
          <Logo size={32} />
          <div>
            <p className="text-white text-sm font-bold tracking-tight">PawaSave</p>
            <p className="text-slate-300 text-[11px]">{profile?.display_name || user?.email}</p>
          </div>
        </div>
        <button
          onClick={() => { if (confirm('Log out?')) signOut() }}
          className="text-slate-300 hover:text-white transition p-2"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </header>

      {profile && profile.kyc_status !== 'verified' && showKycReminder && (
        <div className="mx-4 mt-4 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-amber-900">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold flex items-center gap-1.5"><ShieldCheck className="w-4 h-4" />Verify your account</p>
              <p className="text-xs mt-1">You can skip for now, but KYC is mandatory before any withdrawal.</p>
              <button
                onClick={() => setShowKycGate(true)}
                className="mt-2 text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg transition"
              >
                Start KYC
              </button>
            </div>
            <button onClick={() => setShowKycReminder(false)} className="text-amber-700 hover:text-amber-900">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <main className="flex-1 overflow-y-auto pb-24">
        <div className="max-w-lg mx-auto">
          {tab === 'home' && <HomeView wallet={wallet} transactions={transactions} user={user} refresh={refresh} profile={profile} onStartKyc={() => setShowKycGate(true)} onNavigateVault={() => setTab('vault')} />}
          {tab === 'vault' && <VaultView wallet={wallet} refresh={refresh} />}
          {tab === 'groups' && <GroupsView user={user} wallet={wallet} />}
          {tab === 'activity' && <ActivityView transactions={transactions} />}
          {tab === 'support' && (
            <div className="px-4 pt-5 pb-6">
              <div className="bg-white/95 rounded-2xl p-5 border border-white/60">
                <h2 className="text-lg font-bold text-slate-900">Support</h2>
                <p className="text-xs text-slate-500 mt-1">Toggle AI FAQ support, and escalate to a human if needed.</p>

                <div className="mt-4 flex items-center justify-between bg-slate-100 rounded-xl px-3 py-2">
                  <span className="text-sm font-medium text-slate-700">AI FAQ Assistant</span>
                  <button
                    onClick={() => setSupportAiMode(!supportAiMode)}
                    className={`w-12 h-7 rounded-full transition ${supportAiMode ? 'bg-emerald-500' : 'bg-slate-300'}`}
                  >
                    <span className={`block w-5 h-5 bg-white rounded-full transition-transform ${supportAiMode ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>

                <textarea
                  value={supportMessage}
                  onChange={(e) => setSupportMessage(e.target.value)}
                  rows={4}
                  placeholder="Ask a question about deposits, withdrawals, KYC, or PIN"
                  className="w-full mt-4 px-3 py-2.5 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />

                {supportAiMode && supportMessage.trim() && (
                  <div className="mt-3 bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm text-emerald-900">
                    {answerFaq(supportMessage)}
                  </div>
                )}

                <div className="mt-4 flex items-center justify-between bg-slate-100 rounded-xl px-3 py-2">
                  <span className="text-sm font-medium text-slate-700">Connect me to support agent</span>
                  <button
                    onClick={() => setRequestHuman(!requestHuman)}
                    className={`w-12 h-7 rounded-full transition ${requestHuman ? 'bg-blue-500' : 'bg-slate-300'}`}
                  >
                    <span className={`block w-5 h-5 bg-white rounded-full transition-transform ${requestHuman ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>

                {requestHuman && (
                  <div className="mt-3 bg-blue-50 border border-blue-200 rounded-xl px-3 py-3">
                    <p className="text-xs text-blue-700 mb-3">
                      Our support team is ready to help. Choose your preferred channel:
                    </p>
                    <div className="flex flex-col gap-2">
                      <a
                        href={`https://wa.me/2348067117651?text=${encodeURIComponent(`Hi PawaSave support! My account: ${user?.email || ''}\n\nIssue: ${supportMessage || '(no description)'}`)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 bg-green-600 text-white text-xs font-semibold px-4 py-2 rounded-lg hover:bg-green-700 transition"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                        WhatsApp Support
                      </a>
                      <a
                        href={`mailto:support@pawasave.xyz?subject=Support Request&body=Account: ${user?.email || ''}\n\n${supportMessage || ''}`}
                        className="inline-flex items-center gap-1.5 bg-blue-600 text-white text-xs font-semibold px-4 py-2 rounded-lg hover:bg-blue-700 transition"
                      >
                        Email Support →
                      </a>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          {tab === 'settings' && (
            <div className="px-4 pt-5 pb-6 space-y-4">
              <div className="bg-white/95 rounded-2xl p-5 border border-white/60">
                <h2 className="text-lg font-bold text-slate-900">Settings</h2>
                <p className="text-xs text-slate-500 mt-1">Balance info, payment security, and personalization.</p>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="bg-slate-100 rounded-xl px-3 py-2.5">
                    <p className="text-[11px] text-slate-500">USDC Vault</p>
                    <p className="text-sm font-semibold text-slate-900">{wallet ? (wallet.usdc_balance_micro / 1_000_000).toFixed(2) : '0.00'} USDC</p>
                  </div>
                  <div className="bg-slate-100 rounded-xl px-3 py-2.5">
                    <p className="text-[11px] text-slate-500">cNGN Pool</p>
                    <p className="text-sm font-semibold text-slate-900">{wallet ? (wallet.cngn_pool_micro / 1_000_000).toFixed(2) : '0.00'} cNGN</p>
                  </div>
                </div>
              </div>

              <div className="bg-white/95 rounded-2xl p-5 border border-white/60">
                <h3 className="text-sm font-semibold text-slate-900">Payment Security</h3>
                <p className="text-xs text-slate-500 mt-1">Set or change your 4-digit withdrawal PIN.</p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                    placeholder="New PIN"
                    className="px-3 py-2.5 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={pinConfirm}
                    onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ''))}
                    placeholder="Repeat PIN"
                    className="px-3 py-2.5 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <button
                  onClick={savePin}
                  className="mt-3 bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition"
                >
                  Save PIN
                </button>
                {settingsFeedback && <p className="text-xs mt-2 text-slate-600">{settingsFeedback}</p>}
              </div>

              <div className="bg-white/95 rounded-2xl p-5 border border-white/60">
                <h3 className="text-sm font-semibold text-slate-900">Theme</h3>
                <div className="mt-3 flex gap-2">
                  {(['mint', 'ocean', 'sunset'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTheme(t)}
                      className={`px-3 py-2 rounded-xl text-xs font-semibold transition ${theme === t ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Bottom Nav */}
      <nav className="fixed bottom-0 inset-x-0 bg-white/90 backdrop-blur border-t border-slate-200 z-50 safe-bottom">
        <div className="max-w-lg mx-auto flex">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 transition-colors ${
                tab === id ? 'text-emerald-600' : 'text-slate-400'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}
