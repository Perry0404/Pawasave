'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatNaira } from '@/lib/format'
import { CircleNotch, CheckCircle, XCircle, ArrowLeft, Lock, ShieldCheck, Storefront } from '@phosphor-icons/react'
import Logo from '@/components/logo'

const supabase = createClient()

interface Order {
  reference: string
  amountNgn: number
  escrow: boolean
  status: 'pending' | 'paid' | 'released' | 'refunded' | 'disputed' | 'cancelled'
  note: string | null
  surface: string
  autoReleaseAt: string | null
  seller: { tag: string | null; name: string }
  isSeller: boolean
  isBuyer: boolean
}

const STATUS_COPY: Record<Order['status'], string> = {
  pending: 'Awaiting payment',
  paid: 'Paid — held in escrow',
  released: 'Completed',
  refunded: 'Refunded',
  disputed: 'Disputed — under review',
  cancelled: 'Cancelled',
}

export default function PayPage({ params }: { params: { reference: string } }) {
  const reference = decodeURIComponent(params.reference)
  const router = useRouter()

  const [order, setOrder] = useState<Order | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [user, setUser] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [done, setDone] = useState<'' | 'paid' | 'released'>('')

  const load = useCallback(() => {
    fetch(`/api/pawa/order/${encodeURIComponent(reference)}`)
      .then((r) => r.json())
      .then((d) => { if (d.error) setLoadErr(d.error); else setOrder(d) })
      .catch(() => setLoadErr('Failed to load this payment'))
  }, [reference])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user ?? null))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user ?? null))
    return () => subscription.unsubscribe()
  }, [])

  const pay = async () => {
    if (!user) { router.push(`/?pay=${encodeURIComponent(reference)}`); return }
    setBusy(true); setFeedback('')
    try {
      const res = await fetch('/api/pawa/pay', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference }),
      })
      const d = await res.json()
      if (!res.ok) { setFeedback(d.error || 'Could not complete payment'); return }
      setDone(d.escrow ? 'paid' : 'released')
      load()
    } catch { setFeedback('Something went wrong. Try again.') } finally { setBusy(false) }
  }

  const act = async (action: 'release' | 'dispute') => {
    if (!order) return
    setBusy(true); setFeedback('')
    try {
      // The pay page only holds the order's reference; the buyer's release/dispute is resolved to the
      // numeric order id server-side by /api/pawa/release-by-ref.
      const res = await fetch('/api/pawa/release-by-ref', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference, action }),
      })
      const d = await res.json()
      if (!res.ok) { setFeedback(d.error || 'Could not update'); return }
      if (action === 'release') setDone('released')
      load()
    } catch { setFeedback('Something went wrong. Try again.') } finally { setBusy(false) }
  }

  const settled = order && ['released', 'refunded', 'cancelled'].includes(order.status)

  return (
    <div className="min-h-dvh bg-slate-50 flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-6"><Logo size={40} /></div>
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">

          {!order && !loadErr && (
            <div className="flex items-center justify-center py-16">
              <CircleNotch className="w-6 h-6 animate-spin text-slate-400" />
            </div>
          )}

          {loadErr && (
            <div className="p-6 text-center">
              <XCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
              <p className="text-sm font-medium text-slate-700">{loadErr}</p>
              <button onClick={() => router.push('/')} className="mt-4 text-sm text-emerald-600 font-medium flex items-center gap-1 mx-auto">
                <ArrowLeft className="w-4 h-4" /> Back to PawaSave
              </button>
            </div>
          )}

          {order && (
            <>
              <div className="bg-gradient-to-br from-emerald-600 to-green-700 p-6 text-white">
                <p className="text-xs text-emerald-100 font-medium mb-1 uppercase tracking-wide flex items-center gap-1">
                  <Storefront className="w-3.5 h-3.5" /> Pay with Pawa
                </p>
                <h1 className="text-xl font-bold">{order.seller.name}</h1>
                {order.seller.tag && <p className="text-emerald-100 text-sm mt-0.5">@{order.seller.tag}</p>}
              </div>

              <div className="p-5 space-y-4">
                <div className="text-center">
                  <p className="text-3xl font-bold text-slate-900">{formatNaira(Math.round(order.amountNgn * 100))}</p>
                  {order.note && <p className="text-sm text-slate-500 mt-1">{order.note}</p>}
                </div>

                {order.escrow && !settled && (
                  <div className="flex items-start gap-2 bg-emerald-50 rounded-xl px-4 py-3">
                    <Lock className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                    <p className="text-[12px] text-emerald-800 leading-relaxed">
                      Held safely in escrow. The seller only gets paid once you confirm you received your order.
                    </p>
                  </div>
                )}

                <div className="flex items-center justify-center gap-2 text-sm">
                  <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] font-medium ${
                    order.status === 'released' ? 'bg-emerald-100 text-emerald-700'
                    : order.status === 'paid' ? 'bg-amber-100 text-amber-700'
                    : order.status === 'refunded' || order.status === 'cancelled' ? 'bg-slate-100 text-slate-500'
                    : order.status === 'disputed' ? 'bg-red-100 text-red-700'
                    : 'bg-slate-100 text-slate-600'}`}>
                    {order.status === 'released' && <CheckCircle className="w-3.5 h-3.5" />}
                    {STATUS_COPY[order.status]}
                  </span>
                </div>

                {feedback && <p className="text-sm text-red-600 bg-red-50 rounded-xl px-4 py-2.5">{feedback}</p>}
                {done === 'paid' && <p className="text-sm text-emerald-700 bg-emerald-50 rounded-xl px-4 py-2.5">Payment held in escrow. Confirm once your order arrives.</p>}
                {done === 'released' && <p className="text-sm text-emerald-700 bg-emerald-50 rounded-xl px-4 py-2.5">Done — the seller has been paid. Thank you!</p>}

                {/* Buyer: pay a pending order */}
                {order.status === 'pending' && !order.isSeller && (
                  <button onClick={pay} disabled={busy}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-3.5 rounded-xl transition flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-60">
                    {busy ? <CircleNotch className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                    {user ? `Pay ${formatNaira(Math.round(order.amountNgn * 100))}` : 'Sign in to pay'}
                  </button>
                )}

                {/* Buyer: release / dispute a paid escrow order */}
                {order.status === 'paid' && order.isBuyer && (
                  <div className="space-y-2">
                    <button onClick={() => act('release')} disabled={busy}
                      className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-3.5 rounded-xl transition flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-60">
                      {busy ? <CircleNotch className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                      I received my order — release payment
                    </button>
                    <button onClick={() => act('dispute')} disabled={busy}
                      className="w-full text-sm text-red-600 font-medium py-2">
                      Something's wrong — raise a dispute
                    </button>
                  </div>
                )}

                {order.status === 'pending' && order.isSeller && (
                  <p className="text-[12px] text-slate-400 text-center">This is your payment link. Share it with your buyer.</p>
                )}

                <p className="text-[11px] text-slate-400 text-center leading-relaxed">
                  Payments settle instantly in naira on PawaSave. Your money is held safely until you confirm.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
