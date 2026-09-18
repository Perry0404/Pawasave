'use client'

import { useState, useEffect, useCallback } from 'react'
import { formatNaira, timeAgo } from '@/lib/format'
import { Storefront, CircleNotch, CheckCircle, Lock, ArrowLineUpRight, ArrowLineDownLeft } from '@phosphor-icons/react'

type OrderStatus = 'pending' | 'paid' | 'released' | 'refunded' | 'disputed' | 'cancelled'
interface Order {
  id: number
  reference: string
  amountNgn: number
  escrow: boolean
  status: OrderStatus
  note: string | null
  surface: string
  autoReleaseAt: string | null
  createdAt: string
  role: 'buyer' | 'seller'
  counterparty: string
}

const STATUS: Record<OrderStatus, { label: string; cls: string }> = {
  pending:   { label: 'Awaiting payment', cls: 'faint' },
  paid:      { label: 'In escrow',        cls: 'amber' },
  released:  { label: 'Completed',        cls: 'green' },
  refunded:  { label: 'Refunded',         cls: 'faint' },
  disputed:  { label: 'Disputed',         cls: 'neg' },
  cancelled: { label: 'Cancelled',        cls: 'faint' },
}

export default function PawaHub({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<'pay' | 'buying' | 'selling'>('pay')
  const [buying, setBuying] = useState<Order[]>([])
  const [selling, setSelling] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')

  // Pay a seller
  const [toTag, setToTag] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [escrow, setEscrow] = useState(true)

  const loadOrders = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/pawa/orders')
      const d = await res.json().catch(() => ({}))
      if (res.ok) { setBuying(d.buying || []); setSelling(d.selling || []) }
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { loadOrders() }, [loadOrders])

  const pay = async () => {
    const amt = Number(amount)
    const tag = toTag.replace(/^@+/, '').toLowerCase()
    if (!tag) { setFeedback('Enter the seller @tag'); return }
    if (!(amt >= 100)) { setFeedback('Minimum is ₦100'); return }
    setBusy(true); setFeedback('')
    try {
      const res = await fetch('/api/pawa/pay', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: tag, amountNgn: amt, note: note || undefined, escrow }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setFeedback(d?.error || 'Could not pay') } else {
        setFeedback(escrow ? 'Paid — held in escrow until you confirm.' : 'Paid ✓')
        setToTag(''); setAmount(''); setNote(''); await loadOrders(); setTab('buying')
      }
    } catch { setFeedback('Could not pay') } finally { setBusy(false) }
  }

  const act = async (orderId: number, action: 'release' | 'dispute' | 'refund' | 'cancel') => {
    setBusy(true); setFeedback('')
    try {
      const res = await fetch('/api/pawa/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, action }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setFeedback(d?.error || 'Could not update') } else await loadOrders()
    } catch { setFeedback('Could not update') } finally { setBusy(false) }
  }

  const orderCard = (o: Order) => {
    const st = STATUS[o.status]
    return (
      <div key={o.id} className="tx" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <span className="ic">{o.role === 'buyer' ? <ArrowLineUpRight /> : <ArrowLineDownLeft />}</span>
        <div className="mid" style={{ minWidth: 0 }}>
          <div className="nm">{o.role === 'buyer' ? `To ${o.counterparty}` : `From ${o.counterparty}`}{o.escrow && <Lock size={11} style={{ verticalAlign: '-1px', marginLeft: 5, color: 'var(--muted)' }} />}</div>
          <div className="sub">{o.note ? o.note + ' · ' : ''}{timeAgo(o.createdAt)}</div>
        </div>
        <div className="rt" style={{ textAlign: 'right' }}>
          <div className={`amt num ${o.role === 'seller' ? 'pos' : ''}`}>{o.role === 'seller' ? '+' : '−'}{formatNaira(Math.round(o.amountNgn * 100))}</div>
          <div style={{ fontSize: 11, fontWeight: 600, color: `var(--${st.cls})` }}>{st.label}</div>
        </div>
        {/* Actions */}
        {o.role === 'buyer' && o.status === 'paid' && (
          <div style={{ display: 'flex', gap: 8, width: '100%', marginTop: 8 }}>
            <button className="cta" style={{ marginTop: 0, flex: 1 }} onClick={() => act(o.id, 'release')} disabled={busy}>Confirm & release</button>
            <button className="cta ghost" style={{ marginTop: 0, flex: 'none', padding: '0 14px', color: 'var(--neg)' }} onClick={() => act(o.id, 'dispute')} disabled={busy}>Dispute</button>
          </div>
        )}
        {o.role === 'seller' && o.status === 'paid' && (
          <div style={{ width: '100%', marginTop: 8 }}>
            <button className="cta ghost" style={{ marginTop: 0, color: 'var(--neg)' }} onClick={() => act(o.id, 'refund')} disabled={busy}>Refund buyer</button>
          </div>
        )}
        {o.role === 'seller' && o.status === 'pending' && (
          <div style={{ width: '100%', marginTop: 8 }}>
            <button className="cta ghost" style={{ marginTop: 0 }} onClick={() => act(o.id, 'cancel')} disabled={busy}>Cancel link</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="b">
      <button className="back" onClick={onBack}>← Back</button>
      <div className="h2"><Storefront style={{ verticalAlign: '-4px', marginRight: 6 }} />Pay with Pawa</div>
      <p className="p">Pay any PawaSave seller by their @tag — held safely in escrow until you confirm delivery.</p>

      <div className="terms" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        <button className={`term${tab === 'pay' ? ' on' : ''}`} onClick={() => setTab('pay')}>Pay</button>
        <button className={`term${tab === 'buying' ? ' on' : ''}`} onClick={() => setTab('buying')}>Buying</button>
        <button className={`term${tab === 'selling' ? ' on' : ''}`} onClick={() => setTab('selling')}>Selling</button>
      </div>

      {feedback && <div className={`flash ${/paid|✓/.test(feedback) ? 'ok' : 'err'}`}>{feedback}</div>}

      {tab === 'pay' && (
        <div style={{ marginTop: 14 }}>
          <label className="lab">Seller @tag</label>
          <input className="field" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={toTag}
            onChange={(e) => setToTag(e.target.value.replace(/[^a-zA-Z0-9_@]/g, '').toLowerCase())} placeholder="@adaeze_fashions" />

          <label className="lab" style={{ marginTop: 14 }}>Amount (₦)</label>
          <input className="field" type="number" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />

          <label className="lab" style={{ marginTop: 14 }}>What&apos;s it for? (optional)</label>
          <input className="field" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="2 yards Ankara" />

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, color: 'var(--ink)' }}>
            <input type="checkbox" checked={escrow} onChange={(e) => setEscrow(e.target.checked)} />
            Hold in escrow until I confirm delivery
          </label>

          <button className="cta" onClick={pay} disabled={busy}>{busy ? 'Paying…' : 'Pay seller'}</button>
        </div>
      )}

      {tab !== 'pay' && (
        loading ? (
          <div style={{ display: 'grid', placeItems: 'center', padding: '40px 0' }}><CircleNotch className="w-6 h-6 animate-spin" style={{ color: 'var(--muted)' }} /></div>
        ) : (
          (() => {
            const list = tab === 'buying' ? buying : selling
            if (list.length === 0) return <div className="empty" style={{ marginTop: 14 }}><div className="es">{tab === 'buying' ? 'No purchases yet' : 'No sales yet — create a payment link in Profile → Sell with Pawa'}</div></div>
            return <div className="feedcard" style={{ marginTop: 12 }}>{list.map(orderCard)}</div>
          })()
        )
      )}

      {tab === 'selling' && !loading && selling.some((o) => o.status === 'released') && (
        <p className="p" style={{ margin: '12px 3px 0', color: 'var(--green)' }}><CheckCircle style={{ verticalAlign: '-3px', marginRight: 4 }} />Completed sales are paid straight into your balance.</p>
      )}
    </div>
  )
}
