'use client'

import { useState } from 'react'
import { useAuth, useProfile, useWallet, useTransactions } from '@/hooks/use-data'
import HomeView from './home-view'
import VaultView from './vault-view'
import GroupsView from './groups-view'
import ActivityView from './activity-view'
import { Home, Vault, Users, Activity, LogOut, Shield } from 'lucide-react'

type Tab = 'home' | 'vault' | 'groups' | 'activity'

const tabs: { id: Tab; label: string; Icon: React.FC<any> }[] = [
  { id: 'home', label: 'Home', Icon: Home },
  { id: 'vault', label: 'Vault', Icon: Vault },
  { id: 'groups', label: 'Groups', Icon: Users },
  { id: 'activity', label: 'Activity', Icon: Activity },
]

export default function AppShell() {
  const { user, signOut } = useAuth()
  const { profile } = useProfile()
  const { wallet, refresh: refreshWallet } = useWallet()
  const { transactions, refresh: refreshTx } = useTransactions()
  const [tab, setTab] = useState<Tab>('home')

  const refresh = () => { refreshWallet(); refreshTx() }

  return (
    <div className="min-h-dvh bg-slate-50 flex flex-col safe-top">
      {/* Header */}
      <header className="bg-slate-900 px-5 pt-4 pb-3 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center">
            <Shield className="w-4 h-4 text-white" strokeWidth={2.5} />
          </div>
          <div>
            <p className="text-white text-sm font-bold tracking-tight">PawaSave</p>
            <p className="text-slate-500 text-[11px]">{profile?.business_name || user?.email}</p>
          </div>
        </div>
        <button
          onClick={() => { if (confirm('Log out?')) signOut() }}
          className="text-slate-500 hover:text-slate-300 transition p-2"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto pb-24">
        <div className="max-w-lg mx-auto">
          {tab === 'home' && <HomeView wallet={wallet} transactions={transactions} user={user} refresh={refresh} />}
          {tab === 'vault' && <VaultView wallet={wallet} refresh={refresh} />}
          {tab === 'groups' && <GroupsView user={user} />}
          {tab === 'activity' && <ActivityView transactions={transactions} />}
        </div>
      </main>

      {/* Bottom Nav */}
      <nav className="fixed bottom-0 inset-x-0 bg-white border-t border-slate-100 z-50 safe-bottom">
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
