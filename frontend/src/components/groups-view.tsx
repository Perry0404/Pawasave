'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase'
import { formatNaira, formatUsdc, getRate, koboToMicroUsdc, timeAgo } from '@/lib/format'
import { Users, Plus, ChevronRight, Loader2, AlertCircle, ArrowLeft, Send, Vault } from 'lucide-react'
import type { EsusuGroup, EsusuMember, EsusuContribution } from '@/lib/types'
import type { User } from '@supabase/supabase-js'

const supabase = createClient()

interface Props {
  user: User | null
}

export default function GroupsView({ user }: Props) {
  const [groups, setGroups] = useState<(EsusuGroup & { member_count: number })[]>([])
  const [selected, setSelected] = useState<EsusuGroup | null>(null)
  const [members, setMembers] = useState<(EsusuMember & { profile_name?: string })[]>([])
  const [contributions, setContributions] = useState<EsusuContribution[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [payWithUsdc, setPayWithUsdc] = useState(true)

  // Create form
  const [formName, setFormName] = useState('')
  const [formAmount, setFormAmount] = useState('')
  const [formMax, setFormMax] = useState('5')
  const [formFreq, setFormFreq] = useState<EsusuGroup['cycle_period']>('monthly')

  const fetchGroups = useCallback(async () => {
    if (!user) return
    setLoading(true)
    const { data } = await supabase
      .from('esusu_members')
      .select('group_id')
      .eq('user_id', user.id)
    const ids = data?.map((d) => d.group_id) || []
    if (ids.length === 0) { setGroups([]); setLoading(false); return }
    const { data: g } = await supabase
      .from('esusu_groups')
      .select('*')
      .in('id', ids)
      .order('created_at', { ascending: false })
    // count members per group
    const enriched = await Promise.all(
      (g || []).map(async (group) => {
        const { count } = await supabase
          .from('esusu_members')
          .select('*', { count: 'exact', head: true })
          .eq('group_id', group.id)
        return { ...group, member_count: count || 0 }
      })
    )
    setGroups(enriched)
    setLoading(false)
  }, [user])

  useEffect(() => { fetchGroups() }, [fetchGroups])

  const createGroup = async () => {
    if (!user || !formName || !formAmount) return
    const amountKobo = Math.round(parseFloat(formAmount) * 100)
    if (amountKobo < 10000) { setFeedback('Min ₦100 contribution'); return }
    setBusy(true)
    const { data: group, error } = await supabase
      .from('esusu_groups')
      .insert({
        name: formName,
        owner_id: user.id,
        contribution_amount_kobo: amountKobo,
        cycle_period: formFreq,
        max_members: parseInt(formMax),
        current_cycle: 0,
      })
      .select()
      .single()
    if (error) { setFeedback(error.message); setBusy(false); return }
    // add creator as first member
    await supabase.from('esusu_members').insert({
      group_id: group.id,
      user_id: user.id,
      payout_position: 1,
    })
    setBusy(false)
    setShowCreate(false)
    setFormName(''); setFormAmount(''); setFormMax('5')
    fetchGroups()
  }

  const openGroup = async (group: EsusuGroup) => {
    setSelected(group)
    const { data: m } = await supabase
      .from('esusu_members')
      .select('*')
      .eq('group_id', group.id)
      .order('payout_position')
    // get names
    const profileIds = m?.map((x) => x.user_id) || []
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', profileIds)
    const nameMap = new Map(profiles?.map((p) => [p.id, p.display_name]) || [])
    setMembers(
      (m || []).map((x) => ({ ...x, profile_name: nameMap.get(x.user_id) || 'Member' }))
    )
    const { data: c } = await supabase
      .from('esusu_contributions')
      .select('*')
      .eq('group_id', group.id)
      .order('created_at', { ascending: false })
      .limit(30)
    setContributions(c || [])
  }

  const contribute = async () => {
    if (!user || !selected) return
    const member = members.find((m) => m.user_id === user.id)
    if (!member) { setFeedback('Not a member'); return }
    setBusy(true)

    if (payWithUsdc) {
      // First withdraw from USDC vault to naira, then contribute
      const rate = getRate()
      const usdcMicro = koboToMicroUsdc(selected.contribution_amount_kobo, rate)
      const { data: vaultOk, error: vaultErr } = await supabase.rpc('withdraw_from_vault', {
        p_user_id: user.id,
        p_naira_kobo: selected.contribution_amount_kobo,
        p_usdc_micro: usdcMicro,
      })
      if (vaultErr || !vaultOk) {
        setFeedback(vaultErr?.message || 'Insufficient USDC vault balance')
        setBusy(false)
        setTimeout(() => setFeedback(''), 3000)
        return
      }
    }

    const { error } = await supabase.rpc('esusu_contribute', {
      p_user_id: user.id,
      p_group_id: selected.id,
      p_member_id: member.id,
      p_amount_kobo: selected.contribution_amount_kobo,
      p_cycle: selected.current_cycle,
    })
    if (error) { setFeedback(error.message) } else {
      setFeedback('Contribution sent!')
      openGroup(selected)
    }
    setBusy(false)
    setTimeout(() => setFeedback(''), 3000)
  }

  // Detail view
  if (selected) {
    return (
      <div className="px-4 pt-5">
        <button
          onClick={() => setSelected(null)}
          className="flex items-center gap-1 text-sm text-slate-500 mb-4"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-gradient-to-br from-purple-600 to-violet-700 rounded-2xl p-5 text-white mb-4">
          <p className="text-sm text-purple-200 font-medium">{selected.name}</p>
          <p className="text-2xl font-bold mt-1">{formatNaira(selected.contribution_amount_kobo)}</p>
          <p className="text-xs text-purple-300 mt-1">{selected.cycle_period} &middot; Cycle {selected.current_cycle}</p>
        </div>

        {/* Members */}
        <h3 className="text-sm font-semibold text-slate-800 mb-2">Members ({members.length}/{selected.max_members})</h3>
        <div className="space-y-2 mb-4">
          {members.map((m) => (
            <div key={m.id} className="flex justify-between items-center bg-white px-4 py-3 rounded-xl border border-slate-200">
              <div>
                <p className="text-sm font-medium text-slate-800">{m.profile_name}</p>
                <p className="text-xs text-slate-400">Position #{m.payout_position}</p>
              </div>
              {m.user_id === user?.id && (
                <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-medium">You</span>
              )}
            </div>
          ))}
        </div>

        {/* Payment method toggle */}
        <button
          onClick={() => setPayWithUsdc(!payWithUsdc)}
          className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition mb-3 ${
            payWithUsdc ? 'border-cyan-300 bg-cyan-50' : 'border-slate-200 bg-white'
          }`}
        >
          <div className="flex items-center gap-2">
            <Vault className={`w-4 h-4 ${payWithUsdc ? 'text-cyan-600' : 'text-slate-400'}`} />
            <span className={`text-sm font-medium ${payWithUsdc ? 'text-cyan-700' : 'text-slate-600'}`}>
              {payWithUsdc ? 'Paying from USDC Vault' : 'Paying from Naira Wallet'}
            </span>
          </div>
          <div className={`w-9 h-5 rounded-full transition-colors flex items-center ${payWithUsdc ? 'bg-cyan-500 justify-end' : 'bg-slate-300 justify-start'}`}>
            <div className="w-4 h-4 bg-white rounded-full mx-0.5 shadow-sm" />
          </div>
        </button>

        <button
          onClick={contribute}
          disabled={busy}
          className="w-full bg-purple-600 hover:bg-purple-700 text-white font-semibold py-3.5 rounded-xl transition flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-60 mb-4"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Contribute {formatNaira(selected.contribution_amount_kobo)}
          {payWithUsdc && <span className="text-purple-200 text-xs ml-1">(USDC)</span>}
        </button>

        {feedback && (
          <div className={`mb-4 px-4 py-2.5 rounded-xl text-sm font-medium ${
            feedback.includes('sent') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
          }`}>{feedback}</div>
        )}

        {/* Recent Contributions */}
        <h3 className="text-sm font-semibold text-slate-800 mb-2">Recent Contributions</h3>
        {contributions.length === 0 ? (
          <p className="text-sm text-slate-400 py-4 text-center">No contributions yet</p>
        ) : (
          <div className="space-y-2">
            {contributions.map((c) => (
              <div key={c.id} className="bg-white px-4 py-3 rounded-xl border border-slate-200 flex justify-between items-center">
                <div>
                  <p className="text-sm font-medium text-slate-700">Cycle {c.cycle_number}</p>
                  <p className="text-xs text-slate-400">{timeAgo(c.paid_at)}</p>
                </div>
                <p className="text-sm font-semibold text-emerald-600">{formatNaira(c.amount_kobo)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Create group form
  if (showCreate) {
    return (
      <div className="px-4 pt-5">
        <button onClick={() => setShowCreate(false)} className="flex items-center gap-1 text-sm text-slate-500 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="text-lg font-bold text-slate-900 mb-4">Create Esusu Circle</h2>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-slate-500 block mb-1">Circle Name</label>
            <input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="Market Women Circle"
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">Contribution Amount (₦)</label>
            <input
              type="number"
              inputMode="numeric"
              value={formAmount}
              onChange={(e) => setFormAmount(e.target.value)}
              placeholder="10000"
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">Max Members</label>
            <input
              type="number"
              inputMode="numeric"
              value={formMax}
              onChange={(e) => setFormMax(e.target.value)}
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">Frequency</label>
            <div className="flex bg-slate-100 rounded-xl p-1">
              <button
                onClick={() => setFormFreq('weekly')}
                className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition ${formFreq === 'weekly' ? 'bg-white shadow-sm text-purple-700' : 'text-slate-500'}`}
              >Weekly</button>
              <button
                onClick={() => setFormFreq('monthly')}
                className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition ${formFreq === 'monthly' ? 'bg-white shadow-sm text-purple-700' : 'text-slate-500'}`}
              >Monthly</button>
            </div>
          </div>
          {feedback && (
            <div className="px-4 py-2.5 rounded-xl text-sm font-medium bg-red-50 text-red-700">{feedback}</div>
          )}
          <button
            onClick={createGroup}
            disabled={busy || !formName || !formAmount}
            className="w-full bg-purple-600 hover:bg-purple-700 text-white font-semibold py-3.5 rounded-xl transition flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-60"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Create Circle
          </button>
        </div>
      </div>
    )
  }

  // Main list view
  return (
    <div className="px-4 pt-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-slate-900">Esusu Circles</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1 text-sm font-semibold text-purple-600 bg-purple-50 px-3 py-1.5 rounded-lg hover:bg-purple-100 transition"
        >
          <Plus className="w-4 h-4" /> New
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
      ) : groups.length === 0 ? (
        <div className="text-center py-16">
          <Users className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-sm text-slate-500 mb-1">No circles yet</p>
          <p className="text-xs text-slate-400">Create one to start saving together</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <button
              key={g.id}
              onClick={() => openGroup(g)}
              className="w-full bg-white border border-slate-200 rounded-2xl p-4 text-left flex items-center gap-3 hover:border-purple-300 transition active:scale-[0.98]"
            >
              <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center">
                <Users className="w-5 h-5 text-purple-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-800 truncate">{g.name}</p>
                <p className="text-xs text-slate-400">
                  {formatNaira(g.contribution_amount_kobo)} / {g.cycle_period} &middot; {g.member_count}/{g.max_members} members
                </p>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-400" />
            </button>
          ))}
        </div>
      )}

      <div className="flex items-start gap-2.5 mt-6 bg-purple-50 rounded-xl px-4 py-3">
        <AlertCircle className="w-4 h-4 text-purple-400 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-purple-600 leading-relaxed">
          Esusu is a traditional group savings system. Each cycle, one member receives the pooled contributions. 5% goes to an emergency pot.
        </p>
      </div>
    </div>
  )
}
