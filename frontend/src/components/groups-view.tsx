'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase'
import { formatNaira, getRate, koboToMicroUsdc, timeAgo } from '@/lib/format'
import { Loader2, Copy, Check } from 'lucide-react'
import type { EsusuGroup, EsusuMember, EsusuContribution, Wallet as WalletType } from '@/lib/types'
import type { User } from '@supabase/supabase-js'

const supabase = createClient()

interface Props {
  user: User | null
  wallet: WalletType | null
}

const initialsOf = (n?: string) => (n || 'M').split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase()

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
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [payoutMsg, setPayoutMsg] = useState('')
  const [swept, setSwept] = useState(false)

  // Emergency vote
  const [showEmergency, setShowEmergency] = useState(false)
  const [emergencyRequest, setEmergencyRequest] = useState<null | {
    id: string; requester_id: string; reason: string; amount_kobo: number; status: string
    created_at: string; approve_count: number; reject_count: number; user_voted: boolean
  }>(null)
  const [emergencyReason, setEmergencyReason] = useState('')
  const [emergencyAmount, setEmergencyAmount] = useState('')
  const [emergencyBusy, setEmergencyBusy] = useState(false)

  // Create form
  const [formName, setFormName] = useState('')
  const [formAmount, setFormAmount] = useState('')
  const [formMax, setFormMax] = useState('5')
  const [formFreq, setFormFreq] = useState<EsusuGroup['cycle_period']>('monthly')
  const [formIncentive, setFormIncentive] = useState(0)

  const fetchGroups = useCallback(async () => {
    if (!user) return
    setLoading(true)
    const { data } = await supabase.from('esusu_members').select('group_id').eq('user_id', user.id)
    const ids = data?.map((d) => d.group_id) || []
    if (ids.length === 0) { setGroups([]); setLoading(false); return }
    // One query for the groups + one for ALL their members, then count client-side —
    // instead of a separate count round-trip per group (N+1), which made the Ajo tab
    // slow for anyone in more than a couple of circles.
    const [{ data: g }, { data: memberRows }] = await Promise.all([
      supabase.from('esusu_groups').select('*').in('id', ids).order('created_at', { ascending: false }),
      supabase.from('esusu_members').select('group_id').in('group_id', ids),
    ])
    const counts: Record<string, number> = {}
    for (const r of memberRows || []) counts[r.group_id] = (counts[r.group_id] || 0) + 1
    const enriched = (g || []).map((group) => ({ ...group, member_count: counts[group.id] || 0 }))
    setGroups(enriched)
    setLoading(false)
  }, [user])

  useEffect(() => { fetchGroups() }, [fetchGroups])

  const createGroup = async () => {
    if (!user || !formName || !formAmount) return
    const amountKobo = Math.round(parseFloat(formAmount) * 100)
    if (amountKobo < 10000) { setFeedback('Min ₦100 contribution'); return }
    setBusy(true)
    const { data: group, error } = await supabase.from('esusu_groups').insert({
      name: formName, owner_id: user.id, contribution_amount_kobo: amountKobo,
      cycle_period: formFreq, max_members: parseInt(formMax), current_cycle: 0, creator_incentive_percent: formIncentive,
    }).select().single()
    if (error) { setFeedback(error.message); setBusy(false); return }
    await supabase.from('esusu_members').insert({ group_id: group.id, user_id: user.id, payout_position: 1 })
    setBusy(false)
    setShowCreate(false)
    setFormName(''); setFormAmount(''); setFormMax('5'); setFormIncentive(0)
    fetchGroups()
  }

  // Owner mints a code for a member who has NO smartphone. They dial *111*CODE#, add
  // their BVN over USSD, and are auto-onboarded + joined to this circle.
  const addOfflineMember = async () => {
    if (!selected) return
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('create_ajo_invite', { p_group_id: selected.id, p_label: null })
      if (error || !(data as any)?.code) throw new Error(error?.message || 'Could not create code')
      setInviteCode((data as any).code)
    } catch (e: any) {
      setFeedback(e?.message || 'Could not create invite code')
    } finally {
      setBusy(false)
    }
  }

  const handleShare = async () => {
    if (!selected) return
    const url = `${window.location.origin}/join/${selected.id}`
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: `Join my Ajo circle: ${selected.name}`, text: `Contribute ${formatNaira(selected.contribution_amount_kobo)} ${selected.cycle_period} in our savings circle on PawaSave.`, url })
        return
      } catch { /* dismissed */ }
    }
    await navigator.clipboard.writeText(url)
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 2500)
  }

  const loadEmergencyData = useCallback(async () => {
    if (!selected || !user) return
    const { data: req } = await supabase.from('emergency_requests').select('*').eq('group_id', selected.id).eq('status', 'voting').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!req) { setEmergencyRequest(null); return }
    const { data: votes } = await supabase.from('emergency_votes').select('approve, voter_id').eq('request_id', req.id)
    const approveCount = votes?.filter((v) => v.approve).length || 0
    const rejectCount = votes?.filter((v) => !v.approve).length || 0
    const userVoted = votes?.some((v) => v.voter_id === user.id) || false
    setEmergencyRequest({ ...req, approve_count: approveCount, reject_count: rejectCount, user_voted: userVoted })
  }, [selected, user])

  const submitEmergencyRequest = async () => {
    if (!user || !selected || !emergencyReason) return
    const amountKobo = Math.round(parseFloat(emergencyAmount) * 100)
    if (amountKobo <= 0) return
    setEmergencyBusy(true)
    const { data } = await supabase.rpc('request_emergency_payout', { p_group_id: selected.id, p_reason: emergencyReason, p_amount_kobo: amountKobo })
    setEmergencyBusy(false)
    if (data?.ok) { setEmergencyReason(''); setEmergencyAmount(''); await loadEmergencyData() }
    else { setFeedback(data?.error || 'Failed to submit request'); setTimeout(() => setFeedback(''), 3000) }
  }

  const castVote = async (approve: boolean) => {
    if (!user || !emergencyRequest) return
    setEmergencyBusy(true)
    const { data } = await supabase.rpc('cast_emergency_vote', { p_request_id: emergencyRequest.id, p_approve: approve })
    setEmergencyBusy(false)
    if (data?.ok) {
      if (data.disbursed) { setFeedback(`Emergency payout of ${formatNaira(data.amount_kobo)} approved and disbursed!`); setShowEmergency(false); if (selected) openGroup(selected) }
      else if (data.rejected) { setFeedback('Emergency request was rejected by the group.'); setEmergencyRequest(null) }
      else { await loadEmergencyData() }
    } else { setFeedback(data?.error || 'Vote failed') }
    setTimeout(() => setFeedback(''), 4000)
  }

  const openGroup = async (group: EsusuGroup) => {
    setSelected(group)
    setSwept(false)
    const { data: m } = await supabase.from('esusu_members').select('*').eq('group_id', group.id).order('payout_position')
    const profileIds = m?.map((x) => x.user_id) || []
    const { data: profiles } = await supabase.from('profiles').select('id, display_name').in('id', profileIds)
    const nameMap = new Map(profiles?.map((p) => [p.id, p.display_name]) || [])
    setMembers((m || []).map((x) => ({ ...x, profile_name: nameMap.get(x.user_id) || 'Member' })))
    const { data: c } = await supabase.from('esusu_contributions').select('*').eq('group_id', group.id).order('created_at', { ascending: false }).limit(30)
    setContributions(c || [])
    setTimeout(() => setSwept(true), 60)
  }

  const contribute = async () => {
    if (!user || !selected) return
    const member = members.find((m) => m.user_id === user.id)
    if (!member) { setFeedback('Not a member'); return }
    setBusy(true)

    if (paymentMethod === 'crypto') {
      if (!wallet?.deposit_address) { setFeedback('No deposit address found. Please contact support.'); setBusy(false); setTimeout(() => setFeedback(''), 3000); return }
      const cngnMicro = Math.round(selected.contribution_amount_kobo / 100 * 1_000_000)
      const { error } = await supabase.rpc('esusu_contribute_crypto', {
        p_user_id: user.id, p_group_id: selected.id, p_member_id: member.id, p_amount_cngn_micro: cngnMicro, p_cycle: selected.current_cycle, p_wallet_address: wallet.deposit_address,
      })
      if (error) { setFeedback(error.message) } else {
        setFeedback('Crypto contribution recorded!')
        openGroup(selected)
        fetch('/api/esusu/yield', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'deposit', group_id: selected.id, contribution_kobo: selected.contribution_amount_kobo }) }).catch(() => {})
      }
      setBusy(false); setTimeout(() => setFeedback(''), 3000); return
    }

    if (paymentMethod === 'usdc') {
      const rate = getRate()
      const usdcMicro = koboToMicroUsdc(selected.contribution_amount_kobo, rate)
      const freeUsdc = wallet?.usdc_balance_micro || 0
      const cngnPool = wallet?.cngn_pool_micro || 0
      if (usdcMicro > freeUsdc + cngnPool) { setFeedback('Insufficient cNGN balance'); setBusy(false); setTimeout(() => setFeedback(''), 3000); return }
      const { data: vaultOk, error: vaultErr } = await supabase.rpc('withdraw_vault_atomic', { p_user_id: user.id, p_naira_kobo: selected.contribution_amount_kobo, p_usdc_micro: usdcMicro })
      if (vaultErr || !vaultOk) { setFeedback(vaultErr?.message || 'Insufficient cNGN balance'); setBusy(false); setTimeout(() => setFeedback(''), 3000); return }
    }

    const { error } = await supabase.rpc('esusu_contribute', { p_user_id: user.id, p_group_id: selected.id, p_member_id: member.id, p_amount_kobo: selected.contribution_amount_kobo, p_cycle: selected.current_cycle })
    if (error) { setFeedback(error.message) } else {
      setFeedback('Contribution sent!')
      openGroup(selected)
      fetch('/api/esusu/yield', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'deposit', group_id: selected.id, contribution_kobo: selected.contribution_amount_kobo }) }).catch(() => {})
      const { data: payoutResult } = await supabase.rpc('process_esusu_payout', { p_group_id: selected.id })
      if (payoutResult?.ok) {
        setPayoutMsg(payoutResult.completed ? '🎉 Circle complete! All members have been paid.' : `🎉 Cycle ${payoutResult.cycle} complete! Payout sent to the next member.`)
        setTimeout(() => setPayoutMsg(''), 6000)
        openGroup(selected)
        fetch('/api/esusu/yield', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'payout', group_id: selected.id, recipient_user_id: payoutResult.paid_to }) }).catch(() => {})
      }
    }
    setBusy(false); setTimeout(() => setFeedback(''), 3000)
  }

  // ══ DETAIL ══
  if (selected) {
    const N = Math.max(members.length, selected.max_members || members.length || 1)
    const cycle = selected.current_cycle
    const paidIds = new Set(contributions.filter((c) => c.cycle_number === cycle).map((c) => (c as any).member_id))
    const recipientPos = cycle + 1
    const paidCount = paidIds.size
    const potKobo = selected.pot_balance_kobo || selected.contribution_amount_kobo * (selected.max_members || N)
    const recipient = members.find((m) => m.payout_position === recipientPos)
    const isMember = members.some((m) => m.user_id === user?.id)

    // circle geometry
    const R = 100, cx = 132, cy = 132
    const C = 2 * Math.PI * 43
    const dashOffset = swept ? C * (1 - paidCount / N) : C

    return (
      <div className="b">
        <div className="ajohead">
          <div>
            <div className="t">{selected.name}</div>
            <div className="s">{members.length} members · {formatNaira(selected.contribution_amount_kobo)} each · {selected.cycle_period}</div>
          </div>
          <button className="cyclechip" onClick={handleShare} style={{ border: 0, cursor: 'pointer' }}>{linkCopied ? 'Link copied!' : 'Invite'}</button>
        </div>

        {selected.owner_id === user?.id && (
          <div style={{ margin: '0 0 14px' }}>
            {inviteCode ? (
              <div style={{ background: 'var(--card, #12140f)', border: '1px solid var(--line, #20261f)', borderRadius: 12, padding: '12px 14px' }}>
                <div style={{ fontSize: 11, color: 'var(--sub, #8a9a90)' }}>Member code (no smartphone)</div>
                <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '.04em', margin: '2px 0 6px' }}>{inviteCode}</div>
                <div style={{ fontSize: 11, color: 'var(--sub, #8a9a90)', lineHeight: 1.4 }}>
                  Give this code to the member. They dial <b style={{ color: 'var(--ink, #fff)' }}>*111*{inviteCode}#</b>, enter their BVN, and are onboarded &amp; added to this circle.
                </div>
                <button className="cyclechip" style={{ border: 0, cursor: 'pointer', marginTop: 8 }}
                  onClick={() => { navigator.clipboard?.writeText(inviteCode); setInviteCode(inviteCode) }}>Copy code</button>
                <button className="cyclechip" style={{ border: 0, cursor: 'pointer', marginTop: 8, marginLeft: 8 }}
                  onClick={() => setInviteCode(null)}>Done</button>
              </div>
            ) : (
              <button className="cyclechip" onClick={addOfflineMember} disabled={busy} style={{ border: 0, cursor: 'pointer' }}>
                {busy ? 'Creating…' : '+ Add member without smartphone'}
              </button>
            )}
          </div>
        )}

        <div className="circle">
          <svg viewBox="0 0 100 100"><circle className="track" cx="50" cy="50" r="43" /><circle className="prog" cx="50" cy="50" r="43" style={{ strokeDasharray: C, strokeDashoffset: dashOffset, transition: 'stroke-dashoffset 1.1s cubic-bezier(.2,.7,.2,1)' }} /></svg>
          {Array.from({ length: N }).map((_, i) => {
            const m = members[i]
            const ang = (-90 + i * (360 / N)) * Math.PI / 180
            const x = cx + R * Math.cos(ang), y = cy + R * Math.sin(ang)
            const paid = m ? paidIds.has(m.id) : false
            const now = m ? m.payout_position === recipientPos : false
            return (
              <div key={i} className={`node${paid ? ' paid' : ''}${now ? ' now' : ''}`} style={{ left: x, top: y }}>
                {m ? initialsOf(m.user_id === user?.id ? 'You' : m.profile_name) : ''}
              </div>
            )
          })}
          <div className="pot">
            <div>
              <div className="l">This cycle&apos;s pot</div>
              <div className="v num">{formatNaira(potKobo)}</div>
              <div className="who">{recipient ? `${recipient.user_id === user?.id ? 'You receive' : (recipient.profile_name + ' receives')}` : `Cycle ${cycle} of ${selected.max_members}`}</div>
            </div>
          </div>
        </div>

        {selected.owner_id === user?.id && selected.creator_incentive_percent > 0 && (
          <div className="turnbar"><span className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 20h20L12 4z" /></svg></span><div className="mid"><div className="nm">You&apos;re the circle manager</div><div className="sub">Earning {selected.creator_incentive_percent}% of every payout</div></div></div>
        )}

        {/* Payment method */}
        <div className="sect"><span className="h">Pay with</span></div>
        <div className="terms">
          <button className={`term${paymentMethod === 'usdc' ? ' on' : ''}`} onClick={() => setPaymentMethod('usdc')}>Savings</button>
          <button className={`term${paymentMethod === 'naira' ? ' on' : ''}`} onClick={() => setPaymentMethod('naira')}>Naira</button>
          <button className={`term${paymentMethod === 'crypto' ? ' on' : ''}`} onClick={() => setPaymentMethod('crypto')}>Crypto</button>
        </div>

        {paymentMethod === 'crypto' && (
          <div className="info" style={{ marginTop: 12 }}>
            <div className="l">Your deposit address (Base L2)</div>
            {wallet?.deposit_address ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <code className="code" style={{ flex: 1 }}>{wallet.deposit_address}</code>
                <button onClick={() => { navigator.clipboard.writeText(wallet.deposit_address!); setCopied(true); setTimeout(() => setCopied(false), 2000) }} style={{ background: 'none', border: 0, color: 'var(--green)', cursor: 'pointer' }}>{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}</button>
              </div>
            ) : <p className="p" style={{ margin: '4px 0 0' }}>Address generating… refresh in a moment.</p>}
            <p className="p" style={{ margin: '6px 0 0' }}>Send exactly {formatNaira(selected.contribution_amount_kobo)} of cNGN to your address above.</p>
          </div>
        )}

        {isMember && (
          <button className="cta" onClick={contribute} disabled={busy}>{busy ? 'Sending…' : `Contribute ${formatNaira(selected.contribution_amount_kobo)}`}</button>
        )}

        {feedback && <div className={`flash ${/sent|recorded/.test(feedback) ? 'ok' : 'err'}`}>{feedback}</div>}
        {payoutMsg && <div className="flash ok">{payoutMsg}</div>}

        {/* Emergency fund */}
        <div className="sect"><span className="h">Emergency fund</span><button className="m" onClick={async () => { if (!showEmergency) await loadEmergencyData(); setShowEmergency((v) => !v) }}>{formatNaira(selected.emergency_pot_kobo || 0)}</button></div>
        {showEmergency && (
          <div className="rows" style={{ padding: 15 }}>
            {emergencyRequest ? (
              <>
                <div className="nm" style={{ color: 'var(--ink)', fontWeight: 600 }}>{emergencyRequest.reason}</div>
                <div className="v num" style={{ color: 'var(--amber)', margin: '4px 0 8px' }}>{formatNaira(emergencyRequest.amount_kobo)}</div>
                <p className="p" style={{ margin: 0 }}>{emergencyRequest.approve_count} approve · {emergencyRequest.reject_count} reject · of {members.length} members</p>
                {!emergencyRequest.user_voted ? (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button className="cta" style={{ marginTop: 0 }} onClick={() => castVote(true)} disabled={emergencyBusy}>Approve</button>
                    <button className="cta ghost" style={{ marginTop: 0 }} onClick={() => castVote(false)} disabled={emergencyBusy}>Reject</button>
                  </div>
                ) : <p className="p" style={{ margin: '8px 0 0' }}>You have voted. Waiting for other members…</p>}
              </>
            ) : (
              <>
                <p className="p" style={{ margin: '0 0 10px' }}>Request an advance from the pot ({formatNaira(selected.emergency_pot_kobo || 0)} available). Requires a majority vote.</p>
                <label className="lab">Reason</label>
                <input className="field" value={emergencyReason} onChange={(e) => setEmergencyReason(e.target.value)} placeholder="Medical emergency, school fees…" />
                <label className="lab" style={{ marginTop: 10 }}>Amount (₦)</label>
                <input className="field" type="number" inputMode="numeric" value={emergencyAmount} onChange={(e) => setEmergencyAmount(e.target.value)} placeholder="0" />
                <button className="cta" onClick={submitEmergencyRequest} disabled={emergencyBusy || !emergencyReason || !emergencyAmount}>Request emergency payout</button>
              </>
            )}
          </div>
        )}

        {/* Members */}
        <div className="sect"><span className="h">Members ({members.length}/{selected.max_members})</span></div>
        <div className="rows" style={{ padding: '2px 12px' }}>
          {members.map((m) => {
            const paid = paidIds.has(m.id)
            return (
              <div key={m.id} className="memrow" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 4px', borderTop: '1px solid var(--line)' }}>
                <span className="dot" style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--green-soft)', color: 'var(--green)', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 12, flex: 'none' }}>{initialsOf(m.user_id === user?.id ? 'You' : m.profile_name)}</span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{m.user_id === user?.id ? 'You' : m.profile_name}<span style={{ color: 'var(--faint)', fontWeight: 500 }}> · #{m.payout_position}</span></span>
                <span style={{ fontSize: 11, fontWeight: 600, color: paid ? 'var(--green)' : 'var(--faint)' }}>{paid ? 'Paid' : 'Due'}</span>
              </div>
            )
          })}
        </div>

        {/* Recent contributions */}
        <div className="sect"><span className="h">Recent contributions</span></div>
        {contributions.length === 0 ? (
          <div className="empty"><div className="es">No contributions yet</div></div>
        ) : (
          <div className="feedcard">
            {contributions.map((c) => (
              <div key={c.id} className="tx">
                <span className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg></span>
                <div className="mid"><div className="nm">Cycle {c.cycle_number}</div><div className="sub">{timeAgo(c.paid_at)}</div></div>
                <div className="rt"><div className="amt pos num">{formatNaira(c.amount_kobo)}</div></div>
              </div>
            ))}
          </div>
        )}

        <button className="cta ghost" style={{ marginTop: 16, color: 'var(--muted)' }} onClick={() => setSelected(null)}>← Back to circles</button>
      </div>
    )
  }

  // ══ CREATE ══
  if (showCreate) {
    return (
      <div className="b">
        <button className="back" onClick={() => setShowCreate(false)}>← Back</button>
        <div className="h2">Create an Ajo circle</div>
        <p className="p">Save together — each cycle one member receives the pooled pot.</p>

        <label className="lab">Circle name</label>
        <input className="field" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Market Women Circle" />

        <label className="lab" style={{ marginTop: 14 }}>Contribution amount (₦)</label>
        <input className="field" type="number" inputMode="numeric" value={formAmount} onChange={(e) => setFormAmount(e.target.value)} placeholder="10000" />

        <label className="lab" style={{ marginTop: 14 }}>Max members</label>
        <input className="field" type="number" inputMode="numeric" value={formMax} onChange={(e) => setFormMax(e.target.value)} />

        <label className="lab" style={{ marginTop: 14 }}>Frequency</label>
        <div className="terms">
          {(['daily', 'weekly', 'monthly'] as const).map((f) => <button key={f} className={`term${formFreq === f ? ' on' : ''}`} onClick={() => setFormFreq(f)} style={{ textTransform: 'capitalize' }}>{f}</button>)}
        </div>

        <label className="lab" style={{ marginTop: 14 }}>Creator incentive (optional, 0–5%)</label>
        <div className="terms" style={{ gridTemplateColumns: 'repeat(5,1fr)' }}>
          {[0, 1, 2, 3, 5].map((v) => <button key={v} className={`term${formIncentive === v ? ' on' : ''}`} onClick={() => setFormIncentive(v)}>{v === 0 ? 'None' : `${v}%`}</button>)}
        </div>
        {formIncentive > 0 && <p className="p" style={{ margin: '6px 3px 0', color: 'var(--green)' }}>You earn {formIncentive}% of every payout as circle manager.</p>}

        {feedback && <div className="flash err">{feedback}</div>}
        <button className="cta" onClick={createGroup} disabled={busy || !formName || !formAmount}>{busy ? 'Creating…' : 'Create circle'}</button>
      </div>
    )
  }

  // ══ LIST ══
  return (
    <div className="b">
      <div className="ajohead">
        <div><div className="t">Ajo circles</div><div className="s">Save together, get paid in turns · pot earns 27% a year</div></div>
        <button className="cyclechip" onClick={() => setShowCreate(true)} style={{ border: 0, cursor: 'pointer' }}>+ New</button>
      </div>

      {loading ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: '48px 0' }}><Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--muted)' }} /></div>
      ) : groups.length === 0 ? (
        <div className="empty" style={{ marginTop: 14 }}>
          <div className="eh">No circles yet</div>
          <div className="es">Create one to start saving together</div>
          <button className="cta" style={{ maxWidth: 220, margin: '14px auto 0' }} onClick={() => setShowCreate(true)}>Create a circle</button>
        </div>
      ) : (
        <div className="rows" style={{ marginTop: 8 }}>
          {groups.map((g) => (
            <button key={g.id} className="opt" onClick={() => openGroup(g)}>
              <span className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></svg></span>
              <div className="mid"><div className="nm">{g.name}</div><div className="sub">{formatNaira(g.contribution_amount_kobo)} / {g.cycle_period} · {g.member_count}/{g.max_members} members</div></div>
              <span className="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg></span>
            </button>
          ))}
        </div>
      )}

      <p className="p" style={{ margin: '16px 3px 0' }}>Each cycle, one member receives the pooled contributions. 5% goes to an emergency pot. The pot earns 27% a year via PawasaveLend while members save.</p>
    </div>
  )
}