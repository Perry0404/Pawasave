'use client'

import { useEffect, useState } from 'react'
import { HandCoins, ShieldCheck, Lock, TrendingUp, AlertTriangle, Loader2, X, CheckCircle2 } from 'lucide-react'

type Limit = {
  fixed_savings_micro: number
  equity_micro: number
  ltv_fixed_savings: number
  ltv_equity: number
  borrow_limit_micro: number
  available_micro: number
  has_active_loan: boolean
  current_debt_micro: number
}
type Loan = {
  id: string
  principal_micro: number
  apr_percent: number
  accrued_interest_micro: number
  borrowed_at: string
  due_date: string
  status: string
}
type Collateral = { asset_type: string; pledged_value_micro: number; ltv_percent: number }

const naira = (micro: number) =>
  '₦' + (Number(micro || 0) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })

const TERMS = [30, 90, 180] as const

export default function BorrowView({ wallet, refresh }: { wallet: any; refresh: () => Promise<void> }) {
  const [data, setData] = useState<{ limit: Limit | null; activeLoan: Loan | null; collateral: Collateral[]; agreementVersion: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')

  // borrow form
  const [amount, setAmount] = useState('')
  const [term, setTerm] = useState<number>(90)
  const [agreed, setAgreed] = useState(false)
  const [pin, setPin] = useState('')
  const [showAgreement, setShowAgreement] = useState(false)

  // repay form
  const [repayAmount, setRepayAmount] = useState('')

  const load = async () => {
    try {
      const res = await fetch('/api/loans', { cache: 'no-store' })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || 'Could not load')
      setData(j)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const limit = data?.limit
  const loan = data?.activeLoan
  const debt = loan ? loan.principal_micro + loan.accrued_interest_micro : 0
  const spendable = Number(wallet?.usdc_balance_micro || 0)
  const overdue = loan ? new Date(loan.due_date).getTime() < Date.now() : false

  async function borrow() {
    setError(''); setOk('')
    if (!agreed) { setError('Please read and accept the loan agreement'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/loans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'borrow', amountNgn: Number(amount), tenorDays: term, agreementAccepted: true, transactionPin: pin }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || 'Borrow failed')
      setOk(`${naira(j.net_disbursed_micro)} disbursed to your balance`)
      setAmount(''); setPin(''); setAgreed(false)
      await Promise.all([load(), refresh()])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function repay() {
    setError(''); setOk('')
    setBusy(true)
    try {
      const res = await fetch('/api/loans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'repay', loanId: loan!.id, amountNgn: Number(repayAmount) }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || 'Repayment failed')
      setOk(j.closed ? 'Loan fully repaid — your collateral is released.' : `${naira(j.paid_micro)} repaid`)
      setRepayAmount('')
      await Promise.all([load(), refresh()])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <div className="px-4 pt-10 flex justify-center"><Loader2 className="w-6 h-6 text-white/70 animate-spin" /></div>
  }

  return (
    <div className="px-4 pt-5 pb-6 space-y-4">
      <div className="flex items-center gap-2 text-white">
        <HandCoins className="w-5 h-5" />
        <h2 className="text-lg font-bold">Borrow</h2>
      </div>
      <p className="text-slate-200/80 text-xs -mt-2">Get cash against your assets — no need to sell or break your savings.</p>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-sm text-red-700 flex items-start gap-2"><AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />{error}</div>}
      {ok && <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2.5 text-sm text-emerald-800 flex items-start gap-2"><CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />{ok}</div>}

      {/* ── Active loan → repay ───────────────────────────────────────────── */}
      {loan ? (
        <div className="bg-white/95 rounded-2xl p-5 border border-white/60 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Your loan</h3>
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${overdue ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>
              {overdue ? 'Overdue' : 'Active'}
            </span>
          </div>
          <div className="bg-slate-900 rounded-xl p-4 text-white">
            <p className="text-[11px] text-slate-300">Amount owed</p>
            <p className="text-2xl font-bold">{naira(debt)}</p>
            <div className="flex justify-between text-[11px] text-slate-300 mt-2">
              <span>{loan.apr_percent}% APR · incl. {naira(loan.accrued_interest_micro)} interest</span>
              <span className={overdue ? 'text-red-300 font-semibold' : ''}>Due {new Date(loan.due_date).toLocaleDateString()}</span>
            </div>
          </div>

          {data && data.collateral.length > 0 && (
            <div className="bg-slate-50 rounded-xl p-3 text-xs text-slate-600">
              <div className="flex items-center gap-1.5 font-medium text-slate-700 mb-1"><Lock className="w-3.5 h-3.5" />Collateral held</div>
              {data.collateral.map((c, i) => (
                <div key={i} className="flex justify-between"><span className="capitalize">{c.asset_type.replace('_', ' ')}</span><span>{naira(c.pledged_value_micro)}</span></div>
              ))}
              <p className="mt-1.5 text-[11px] text-slate-400">Released as soon as you clear the loan. If it goes unpaid, this collateral is used to settle it.</p>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-slate-600 flex justify-between">
              <span>Repay amount</span>
              <button className="text-emerald-600 font-semibold" onClick={() => setRepayAmount((Math.min(debt, spendable) / 1e6).toFixed(2))}>
                Repay all ({naira(Math.min(debt, spendable))})
              </button>
            </label>
            <input value={repayAmount} onChange={(e) => setRepayAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.00"
              className="w-full mt-1 px-3 py-2.5 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            <p className="text-[11px] text-slate-400 mt-1">From your spendable balance ({naira(spendable)}).</p>
          </div>
          <button onClick={repay} disabled={busy || !repayAmount}
            className="w-full bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-xl flex items-center justify-center gap-2">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}Repay
          </button>
        </div>
      ) : (
        <>
          {/* ── Collateral display ──────────────────────────────────────── */}
          <div className="bg-white/95 rounded-2xl p-5 border border-white/60">
            <div className="flex items-center gap-1.5 mb-3"><ShieldCheck className="w-4 h-4 text-emerald-600" /><h3 className="text-sm font-semibold text-slate-900">Your collateral</h3></div>
            <div className="space-y-2">
              <div className="flex items-center justify-between bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2.5">
                <div className="flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-600" /><div><p className="text-sm font-medium text-slate-800">Stocks</p><p className="text-[11px] text-slate-500">{limit?.ltv_equity ?? 40}% borrowing power · live value</p></div></div>
                <p className="text-sm font-semibold text-slate-900">{naira(limit?.equity_micro || 0)}</p>
              </div>
              <div className="flex items-center justify-between bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2.5">
                <div className="flex items-center gap-2"><Lock className="w-4 h-4 text-emerald-600" /><div><p className="text-sm font-medium text-slate-800">Fixed savings</p><p className="text-[11px] text-slate-500">{limit?.ltv_fixed_savings ?? 70}% borrowing power</p></div></div>
                <p className="text-sm font-semibold text-slate-900">{naira(limit?.fixed_savings_micro || 0)}</p>
              </div>
            </div>

            <div className="mt-4 bg-slate-900 rounded-xl p-4 text-white text-center">
              <p className="text-[11px] text-slate-300">You can borrow up to</p>
              <p className="text-3xl font-bold">{naira(limit?.available_micro || 0)}</p>
            </div>

            {(!limit || (limit.fixed_savings_micro === 0 && limit.equity_micro === 0)) && (
              <p className="mt-3 text-xs text-slate-500 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5">
                You don’t have any assets to borrow against yet. Buy a <span className="font-semibold">Stock</span> under “Invest”, or lock a <span className="font-semibold">Fixed Savings</span> under “Save”, then borrow against it here — without selling or breaking it.
              </p>
            )}
          </div>

          {/* ── Borrow form ─────────────────────────────────────────────── */}
          {limit && limit.available_micro > 0 && (
            <div className="bg-white/95 rounded-2xl p-5 border border-white/60 space-y-4">
              <h3 className="text-sm font-semibold text-slate-900">Take a loan</h3>
              <div>
                <label className="text-xs font-medium text-slate-600 flex justify-between">
                  <span>Amount (cNGN)</span>
                  <button className="text-emerald-600 font-semibold" onClick={() => setAmount((limit.available_micro / 1e6).toFixed(2))}>MAX {naira(limit.available_micro)}</button>
                </label>
                <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.00"
                  className="w-full mt-1 px-3 py-2.5 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600">Repay in</label>
                <div className="grid grid-cols-3 gap-2 mt-1">
                  {TERMS.map((d) => (
                    <button key={d} onClick={() => setTerm(d)}
                      className={`py-2 rounded-xl text-sm font-semibold transition ${term === d ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
                      {d} days
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-start gap-2 text-xs text-slate-600">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 accent-emerald-600" />
                <span>I have read and accept the <button type="button" onClick={() => setShowAgreement(true)} className="text-emerald-600 font-semibold underline">Loan Agreement</button>.</span>
              </label>

              <div>
                <label className="text-xs font-medium text-slate-600">Transaction PIN</label>
                <input type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••"
                  className="w-full mt-1 px-3 py-2.5 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 tracking-widest" />
              </div>

              <button onClick={borrow} disabled={busy || !amount || !agreed || pin.length !== 4}
                className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-xl flex items-center justify-center gap-2">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <HandCoins className="w-4 h-4" />}Borrow
              </button>
              <p className="text-[11px] text-slate-400 text-center">A small origination fee applies. Your collateral is released when you repay.</p>
            </div>
          )}
        </>
      )}

      {/* ── Loan agreement modal ─────────────────────────────────────────── */}
      {showAgreement && (
        <div className="fixed inset-0 bg-black/50 z-[60] flex items-end sm:items-center justify-center p-4" onClick={() => setShowAgreement(false)}>
          <div className="bg-white rounded-2xl max-w-lg w-full max-h-[80dvh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-slate-900">Loan Agreement</h3>
              <button onClick={() => setShowAgreement(false)}><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="text-xs text-slate-600 space-y-2 leading-relaxed">
              <p><strong>1. Collateral.</strong> You pledge in-app assets (currently your fixed savings) as security. Pledged assets are locked and cannot be withdrawn until the loan is fully repaid.</p>
              <p><strong>2. Interest &amp; fees.</strong> Interest accrues daily at the stated APR. A one-off origination fee is deducted from the amount disbursed.</p>
              <p><strong>3. Repayment.</strong> Repay any time before the due date from your spendable balance. Repayments are applied to interest first, then principal.</p>
              <p><strong>4. Default &amp; liquidation.</strong> If the loan is not repaid by the due date (after a short grace period), or if your debt reaches the liquidation threshold of your collateral value, PawaSave will seize your pledged collateral to settle the loan. Any surplus after settlement is returned to your balance.</p>
              <p><strong>5. Authorization.</strong> By accepting, you authorize PawaSave to lock, and if necessary liquidate, your pledged assets to recover amounts owed. Version: {data?.agreementVersion}.</p>
            </div>
            <button onClick={() => { setAgreed(true); setShowAgreement(false) }} className="w-full mt-4 bg-emerald-600 text-white text-sm font-semibold py-2.5 rounded-xl">
              I Agree
            </button>
          </div>
        </div>
      )}
    </div>
  )
}