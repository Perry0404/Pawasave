'use client'

import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'

type Limit = {
  fixed_savings_micro: number
  equity_micro: number
  rwa_micro?: number
  ltv_fixed_savings: number
  ltv_equity: number
  ltv_rwa?: number
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

const IconStock = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8" /><path d="M17 7h4v4" /></svg>
const IconLock = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="9" width="16" height="12" rx="2" /><path d="M8 9V7a4 4 0 0 1 8 0v2" /></svg>
const IconCheck = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>

export default function BorrowView({ wallet, refresh }: { wallet: any; refresh: () => Promise<void> }) {
  const [data, setData] = useState<{ limit: Limit | null; activeLoan: Loan | null; collateral: Collateral[]; agreementVersion: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')

  const [amount, setAmount] = useState('')
  const [term, setTerm] = useState<number>(90)
  const [agreed, setAgreed] = useState(false)
  const [pin, setPin] = useState('')
  const [showAgreement, setShowAgreement] = useState(false)
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

  if (loading) return <div className="b" style={{ display: 'grid', placeItems: 'center', minHeight: '40vh' }}><Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--muted)' }} /></div>

  const noAssets = !limit || (limit.fixed_savings_micro === 0 && limit.equity_micro === 0 && (limit.rwa_micro || 0) === 0)

  return (
    <div className="b">
      <div className="h2">Borrow</div>
      <p className="p">Cash against what you own — no selling, no broken savings.</p>

      {error && <div className="flash err">{error}</div>}
      {ok && <div className="flash ok">{ok}</div>}

      {loan ? (
        <>
          <div className="pool rise">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="l">Amount owed</div>
              <span className="apy" style={{ marginTop: 0, background: overdue ? 'rgba(224,106,92,.3)' : 'rgba(255,255,255,.16)' }}>{overdue ? 'Overdue' : 'Active'}</span>
            </div>
            <div className="v num">{naira(debt)}</div>
            <span className="apy">{loan.apr_percent}% APR · incl. {naira(loan.accrued_interest_micro)} interest · due {new Date(loan.due_date).toLocaleDateString()}</span>
          </div>

          {data && data.collateral.length > 0 && (
            <>
              <div className="sect"><span className="h">Collateral held</span></div>
              <div className="rows">
                {data.collateral.map((c, i) => (
                  <div key={i} className="coll">
                    <span className="dot">{c.asset_type === 'equity' ? <IconStock /> : <IconLock />}</span>
                    <div className="mid"><div className="nm" style={{ textTransform: 'capitalize' }}>{c.asset_type.replace('_', ' ')}</div><div className="sub">Released when you clear the loan</div></div>
                    <span className="v num">{naira(c.pledged_value_micro)}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="sect"><span className="h">Repay</span><button className="m" onClick={() => setRepayAmount((Math.min(debt, spendable) / 1e6).toFixed(2))}>Repay all ({naira(Math.min(debt, spendable))})</button></div>
          <input className="field" value={repayAmount} onChange={(e) => setRepayAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.00" inputMode="decimal" />
          <p className="p" style={{ margin: '6px 3px 0' }}>From your spendable balance ({naira(spendable)}).</p>
          <button className="cta" onClick={repay} disabled={busy || !repayAmount}>{busy ? 'Repaying…' : 'Repay'}</button>
        </>
      ) : (
        <>
          <div className="bignum rise">
            <div className="l">You can borrow up to</div>
            <div className="v num">{naira(limit?.available_micro || 0)}</div>
          </div>

          <div className="sect"><span className="h">Your collateral</span></div>
          <div className="rows">
            <div className="coll">
              <span className="dot"><IconStock /></span>
              <div className="mid"><div className="nm">Stocks</div><div className="sub">{limit?.ltv_equity ?? 40}% power · live value</div></div>
              <span className="v num">{naira(limit?.equity_micro || 0)}</span>
            </div>
            <div className="coll">
              <span className="dot"><IconLock /></span>
              <div className="mid"><div className="nm">Fixed savings</div><div className="sub">{limit?.ltv_fixed_savings ?? 70}% power</div></div>
              <span className="v num">{naira(limit?.fixed_savings_micro || 0)}</span>
            </div>
            {(limit?.rwa_micro || 0) > 0 && (
              <div className="coll">
                <span className="dot"><IconStock /></span>
                <div className="mid"><div className="nm">Naira assets</div><div className="sub">{limit?.ltv_rwa ?? 80}% power · T-bills & funds</div></div>
                <span className="v num">{naira(limit?.rwa_micro || 0)}</span>
              </div>
            )}
          </div>

          {noAssets && (
            <div className="note">
              You don’t have any assets to borrow against yet. Buy a <b style={{ color: 'var(--ink)' }}>Stock</b> under Invest, or lock a <b style={{ color: 'var(--ink)' }}>Fixed deposit</b> under Save, then borrow against it here — without selling or breaking it.
            </div>
          )}

          {limit && limit.available_micro > 0 && (
            <>
              <div className="sect"><span className="h">Take a loan</span><button className="m" onClick={() => setAmount((limit.available_micro / 1e6).toFixed(2))}>MAX {naira(limit.available_micro)}</button></div>
              <input className="field" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.00" inputMode="decimal" />

              <label className="lab" style={{ marginTop: 14 }}>Repay in</label>
              <div className="terms">
                {TERMS.map((d) => <button key={d} className={`term${term === d ? ' on' : ''}`} onClick={() => setTerm(d)}>{d} days</button>)}
              </div>

              <label style={{ display: 'flex', gap: 9, marginTop: 14, fontSize: 12, color: 'var(--muted)' }}>
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 2 }} />
                <span>I have read and accept the <button type="button" onClick={() => setShowAgreement(true)} style={{ color: 'var(--green)', fontWeight: 600, background: 'none', border: 0, textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>Loan Agreement</button>.</span>
              </label>

              <label className="lab" style={{ marginTop: 14 }}>Transaction PIN</label>
              <input className="field" type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" style={{ letterSpacing: '.3em' }} />

              <button className="cta" onClick={borrow} disabled={busy || !amount || !agreed || pin.length !== 4}>{busy ? 'Processing…' : 'Borrow'}</button>
              <p className="p" style={{ margin: '10px 3px 0', textAlign: 'center' }}>A small origination fee applies. Collateral released when you repay.</p>
            </>
          )}
        </>
      )}

      {showAgreement && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 60, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 16 }} onClick={() => setShowAgreement(false)}>
          <div className="rows" style={{ maxWidth: 480, width: '100%', maxHeight: '80dvh', overflowY: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div className="h2" style={{ margin: 0 }}>Loan Agreement</div>
              <button onClick={() => setShowAgreement(false)} style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--muted)' }}><X className="w-5 h-5" /></button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p><b style={{ color: 'var(--ink)' }}>1. Collateral.</b> You pledge in-app assets (fixed savings and/or stocks) as security. Pledged assets are locked until the loan is fully repaid.</p>
              <p><b style={{ color: 'var(--ink)' }}>2. Interest &amp; fees.</b> Interest accrues daily at the stated APR. A one-off origination fee is deducted from the amount disbursed.</p>
              <p><b style={{ color: 'var(--ink)' }}>3. Repayment.</b> Repay any time before the due date from your spendable balance. Repayments apply to interest first, then principal.</p>
              <p><b style={{ color: 'var(--ink)' }}>4. Default &amp; liquidation.</b> If unpaid by the due date (after a short grace period), or if your debt reaches the liquidation threshold of your collateral value, PawaSave seizes your pledged collateral to settle the loan. Any surplus is returned to your balance.</p>
              <p><b style={{ color: 'var(--ink)' }}>5. Authorization.</b> By accepting, you authorize PawaSave to lock, and if necessary liquidate, your pledged assets. Version: {data?.agreementVersion}.</p>
            </div>
            <button className="cta" onClick={() => { setAgreed(true); setShowAgreement(false) }}>I Agree</button>
          </div>
        </div>
      )}
    </div>
  )
}