'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase'
import { formatNaira, formatUsdc, getRate, koboToMicroUsdc, timeAgo } from '@/lib/format'
import { Users, Plus, ChevronRight, Loader2, AlertCircle, ArrowLeft, Send, Vault, Wallet, Copy, Check, Share2 } from 'lucide-react'
import type { EsusuGroup, EsusuMember, EsusuContribution, Wallet as WalletType } from '@/lib/types'
import type { User } from '@supabase/supabase-js'

const supabase = createClient()

interface Props {
  user: User | null
  wallet: WalletType | null
}

export default function GroupsView({ user, wallet }: Props) {
  const [groups, setGroups] = useState<(EsusuGroup & { member_count: number })[]>([])
  const [selected, setSelected] = useState<EsusuGroup | null>(null)
  const [members, setMembers] = useState<(EsusuMember & { profile_name?: string })[]>([])
  const [contributions, setContributions] = useState<EsusuContribution[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'usdc' | 'naira' | 'crypto'>('usdc')
  const [copied, setCopied] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const [payoutMsg, setPayoutMsg] = useState('')

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

  const handleShare = async () => {
    if (!selected) return
    const url = `${window.location.origin}/join/${selected.id}`
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: `Join my Ajo circle: ${selected.name}`,
          text: `Contribute ${formatNaira(selected.contribution_amount_kobo)} ${selected.cycle_period} in our savings circle on PawaSave.`,
          url,
        })
        return
      } catch { /* user dismissed share sheet */ }
    }
    await navigator.clipboard.writeText(url)
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 2500)
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

    if (paymentMethod === 'crypto') {
      // Crypto wallet deposit from user's personal deposit address
      if (!wallet?.deposit_address) {
        setFeedback('No deposit address found. Please contact support.')
        setBusy(false)
        setTimeout(() => setFeedback(''), 3000)
        return
      }
      const cngnMicro = Math.round(selected.contribution_amount_kobo / 100 * 1_000_000) // 1 cNGN = 1 NGN
      const { error } = await supabase.rpc('esusu_contribute_crypto', {
        p_user_id: user.id,
        p_group_id: selected.id,
        p_member_id: member.id,
        p_amount_cngn_micro: cngnMicro,
        p_cycle: selected.current_cycle,
        p_wallet_address: wallet.deposit_address,
      })
      if (error) { setFeedback(error.message) } else {
        setFeedback('Crypto contribution recorded!')
        openGroup(selected)
        // Fire-and-forget: deploy pot to XEND MM (33% APY)
        fetch('/api/esusu/yield', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'deposit',
            group_id: selected.id,
            contribution_kobo: selected.contribution_amount_kobo,
          }),
        }).catch(() => {})
      }
      setBusy(false)
      setTimeout(() => setFeedback(''), 3000)
      return
    }

    if (paymentMethod === 'usdc') {
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
      // Fire-and-forget: deploy pot to XEND MM (33% APY)
      fetch('/api/esusu/yield', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'deposit',
          group_id: selected.id,
          contribution_kobo: selected.contribution_amount_kobo,
        }),
      }).catch(() => {})
      // Check if cycle is now complete and trigger payout
      const { data: payoutResult } = await supabase.rpc('process_esusu_payout', { p_group_id: selected.id })
      if (payoutResult?.ok) {
        setPayoutMsg(payoutResult.completed
          ? '🎉 Circle complete! All members have been paid.'
          : `🎉 Cycle ${payoutResult.cycle} complete! Payout sent to the next member.`
        )
        setTimeout(() => setPayoutMsg(''), 6000)
        openGroup(selected) // refresh updated cycle
        // Pay out any accumulated yield as a bonus on top of the base pot
        fetch('/api/esusu/yield', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'payout',
            group_id: selected.id,
            recipient_user_id: payoutResult.paid_to,
          }),
        }).catch(() => {})
      }
    }
    setBusy(false)
    setTimeout(() => setFeedback(''), 3000)
  }

  // Detail view
  if (selected) {
    return (
      <div className="px-4 pt-5">
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={() => setSelected(null)}
            className="flex items-center gap-1 text-sm text-slate-500"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <button
            onClick={handleShare}
            className="flex items-center gap-1.5 text-sm font-semibold text-purple-600 bg-purple-50 px-3 py-1.5 rounded-lg hover:bg-purple-100 transition"
          >
            {linkCopied ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
            {linkCopied ? 'Link copied!' : 'Invite'}
          </button>
        </div>
        <div className="bg-gradient-to-br from-purple-600 to-violet-700 rounded-2xl p-5 text-white mb-4">
          <div className="flex items-start justify-between">
            <p className="text-sm text-purple-200 font-medium">{selected.name}</p>
            <span className="text-[10px] font-bold bg-emerald-400/20 text-emerald-300 px-2 py-0.5 rounded-full border border-emerald-400/30">
              33% APY
            </span>
          </div>
          <p className="text-2xl font-bold mt-1">{formatNaira(selected.contribution_amount_kobo)}</p>
          <p className="text-xs text-purple-300 mt-1">{selected.cycle_period} &middot; Cycle {selected.current_cycle} &middot; Pot earning yield</p>
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

        {/* Payment method selector */}
        <div className="mb-3">
          <p className="text-xs font-medium text-slate-500 mb-2">Payment Method</p>
          <div className="flex bg-slate-100 rounded-xl p-1">
            <button
              onClick={() => setPaymentMethod('usdc')}
              className={`flex-1 py-2 text-xs font-semibold rounded-lg flex items-center justify-center gap-1 transition ${
                paymentMethod === 'usdc' ? 'bg-white text-cyan-700 shadow-sm' : 'text-slate-500'
              }`}
            >
              <Vault className="w-3 h-3" /> USDC
            </button>
            <button
              onClick={() => setPaymentMethod('naira')}
              className={`flex-1 py-2 text-xs font-semibold rounded-lg flex items-center justify-center gap-1 transition ${
                paymentMethod === 'naira' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'
              }`}
            >
              ₦ Naira
            </button>
            <button
              onClick={() => setPaymentMethod('crypto')}
              className={`flex-1 py-2 text-xs font-semibold rounded-lg flex items-center justify-center gap-1 transition ${
                paymentMethod === 'crypto' ? 'bg-white text-purple-700 shadow-sm' : 'text-slate-500'
              }`}
            >
              <Wallet className="w-3 h-3" /> Crypto
            </button>
          </div>
        </div>

        {/* Crypto deposit details */}
        {paymentMethod === 'crypto' && (
          <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 mb-3 space-y-3">
            <div>
              <p className="text-[11px] text-purple-600 font-medium mb-1">Your Deposit Address (Base L2)</p>
              {wallet?.deposit_address ? (
                <div className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-purple-200">
                  <code className="text-xs text-purple-900 flex-1 break-all">{wallet.deposit_address}</code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(wallet.deposit_address!)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    }}
                    className="text-purple-600 hover:text-purple-800 p-1 flex-shrink-0"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              ) : (
                <p className="text-xs text-purple-600">Address generating... refresh in a moment.</p>
              )}
            </div>
            <p className="text-[10px] text-purple-500">
              Send exactly {formatNaira(selected.contribution_amount_kobo)} worth of cNGN to your personal address above. Funds are non-custodial — only you control this address.
            </p>
          </div>
        )}

        <button
          onClick={contribute}
          disabled={busy}
          className="w-full bg-purple-600 hover:bg-purple-700 text-white font-semibold py-3.5 rounded-xl transition flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-60 mb-4"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Contribute {formatNaira(selected.contribution_amount_kobo)}
          {paymentMethod === 'usdc' && <span className="text-purple-200 text-xs ml-1">(USDC)</span>}
          {paymentMethod === 'crypto' && <span className="text-purple-200 text-xs ml-1">(cNGN)</span>}
        </button>

        {feedback && (
          <div className={`mb-2 px-4 py-2.5 rounded-xl text-sm font-medium ${
            feedback.includes('sent') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
          }`}>{feedback}</div>
        )}

        {payoutMsg && (
          <div className="mb-4 px-4 py-3 rounded-xl text-sm font-medium bg-violet-50 text-violet-700 border border-violet-200">
            {payoutMsg}
          </div>
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
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full">33% APY</span>
                <ChevronRight className="w-4 h-4 text-slate-400" />
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-start gap-2.5 mt-6 bg-purple-50 rounded-xl px-4 py-3">
        <AlertCircle className="w-4 h-4 text-purple-400 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-purple-600 leading-relaxed">
          Esusu is a traditional group savings system. Each cycle, one member receives the pooled contributions. 5% goes to an emergency pot. <span className="font-semibold text-emerald-600">The pot earns 33% APY</span> via Xend Money Market while members save.
        </p>
      </div>
    </div>
  )
}
