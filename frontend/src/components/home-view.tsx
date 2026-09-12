'use client'

import { useState, useEffect } from 'react'
import { formatNaira, microUsdcToKobo, getRate, timeAgo, cleanDescription } from '@/lib/format'
import { initiateDeposit, initiateWithdrawal, getBanks, resolveAccount, type RampResult, type Bank } from '@/lib/flint'
import { talkback } from '@/lib/voice'
// Bank aliased: `Bank` is already the bank-list type from @/lib/flint.
import { ArrowUpRight, ArrowDownLeft, Wallet, CreditCard, CircleNotch, ArrowLeft, Copy, Check, CaretDown, FileText, Bank as BankIcon } from '@phosphor-icons/react'
import type { Profile, Wallet as WalletType, Transaction } from '@/lib/types'
import type { User } from '@supabase/supabase-js'

type View = 'main' | 'deposit-choose' | 'deposit-naira' | 'deposit' | 'deposit-crypto' | 'deposit-info' | 'withdraw'

/** Live availability of each deposit rail (from /api/ramp/status). */
type RampStatus = { naira: { available: boolean; reason?: string }; crypto?: { available: boolean } }

interface Props {
  wallet: WalletType | null
  transactions: Transaction[]
  user: User | null
  refresh: () => void
  profile: Profile | null
  onStartKyc: () => void
  onNavigateVault?: () => void
}

export default function HomeView({ wallet, transactions, user, refresh, profile, onStartKyc, onNavigateVault }: Props) {
  const [view, setView] = useState<View>('main')
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null)
  const [showStatement, setShowStatement] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [amount, setAmount] = useState('')
  const [depositInfo, setDepositInfo] = useState<RampResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [addrCopied, setAddrCopied] = useState(false)
  const [bvn, setBvn] = useState('')
  const [acctCopied, setAcctCopied] = useState(false)
  const [liveRate, setLiveRate] = useState<number>(getRate())
  const [depositAddr, setDepositAddr] = useState<string | null>(wallet?.deposit_address ?? null)
  const [rampStatus, setRampStatus] = useState<RampStatus | null>(null)

  // Withdraw state
  const [banks, setBanks] = useState<Bank[]>([])
  const [bankCode, setBankCode] = useState('')
  const [bankSearch, setBankSearch] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [accountHolderName, setAccountHolderName] = useState('')
  const [banksLoading, setBanksLoading] = useState(false)
  const [banksError, setBanksError] = useState(false)
  const [transactionPin, setTransactionPin] = useState('')
  const [resolvingName, setResolvingName] = useState(false)
  const [nameResolved, setNameResolved] = useState(false)
  const [resolveError, setResolveError] = useState('')

  useEffect(() => {
    if (view === 'withdraw' && banks.length === 0) {
      setBanksLoading(true)
      setBanksError(false)
      getBanks()
        .then(b => { setBanks(b); setBanksLoading(false) })
        .catch(() => { setBanksLoading(false); setBanksError(true) })
    }
  }, [view, banks.length])

  // Name enquiry: once a bank + 10-digit account are entered, resolve the account
  // holder name automatically (like a normal Nigerian transfer). Debounced so we
  // don't hit the resolver on every keystroke. Falls back to manual entry if the
  // lookup isn't configured or the account can't be resolved.
  useEffect(() => {
    if (view !== 'withdraw') return
    if (!bankCode || accountNumber.length !== 10) { setNameResolved(false); setResolveError(''); return }
    let cancelled = false
    setResolvingName(true)
    setNameResolved(false)
    setResolveError('')
    const t = setTimeout(async () => {
      const name = await resolveAccount(bankCode, accountNumber)
      if (cancelled) return
      setResolvingName(false)
      if (name) { setAccountHolderName(name); setNameResolved(true) }
      else setResolveError('Couldn’t verify this account — enter the name manually.')
    }, 500)
    return () => { cancelled = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, bankCode, accountNumber])

  // Onboarding completes by PULL, not by trusting the `user.onboarded` webhook —
  // which is not a guarantee (the deposit webhook 401'd on signature verification
  // three times live). While the naira-account screen shows "Creating your account…",
  // poll Strails directly so the NUBAN lands even if the webhook never fires.
  useEffect(() => {
    const p = profile as any
    const pending = view === 'deposit-naira'
      && p?.strails_onboard_status === 'processing'
      && !p?.strails_va_account_number
    if (!pending) return
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetch('/api/strails/onboard-status')
        const data = await res.json().catch(() => ({}))
        if (!cancelled && data?.ready) await refresh()
      } catch { /* transient — keep polling */ }
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => { cancelled = true; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, (profile as any)?.strails_onboard_status, (profile as any)?.strails_va_account_number])

  useEffect(() => {
    fetch('/api/ramp/rate')
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.rate && Number.isFinite(Number(data.rate))) {
          setLiveRate(Number(data.rate))
        }
      })
      .catch(() => undefined)
  }, [])

  // Ask whether the fiat (naira) rail is actually usable, so the Receive screen
  // can show it as "temporarily unavailable" instead of hiding it on an outage.
  useEffect(() => {
    fetch('/api/ramp/status')
      .then((res) => res.ok ? res.json() : null)
      .then((data) => { if (data?.naira) setRampStatus(data as RampStatus) })
      .catch(() => undefined)
  }, [])

  // Fetch the user's real Base cNGN deposit address and pick up any crypto
  // deposits made since last visit, so a crypto deposit shows up like a fiat one.
  useEffect(() => {
    fetch('/api/wallet/deposit-address')
      .then((res) => res.ok ? res.json() : null)
      .then((data) => { if (data?.address) setDepositAddr(data.address) })
      .catch(() => undefined)

    fetch('/api/wallet/sync-deposits', { method: 'POST' })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => { if (data?.credited > 0) refresh() })
      .catch(() => undefined)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!wallet) return <div className="flex items-center justify-center py-20"><CircleNotch size={24} className="animate-spin" style={{ color: 'var(--faint)' }} /></div>

  const rate = liveRate
  const savingsKobo = microUsdcToKobo(wallet.usdc_balance_micro, rate)
  // Include both pool principal AND accrued yield so balance reflects actual earnings
  const cngnKobo = microUsdcToKobo((wallet.cngn_pool_micro || 0) + (wallet.cngn_yield_earned_micro || 0), rate)
  const totalKobo = wallet.naira_balance_kobo + savingsKobo + cngnKobo
  const recentTxs = transactions.slice(0, 6)

  const flash = (msg: string) => { setFeedback(msg); setTimeout(() => setFeedback(''), 4000) }

  const resetForm = () => { setAmount(''); setDepositInfo(null); setBankCode(''); setBankSearch(''); setAccountNumber(''); setAccountHolderName(''); setCopied(false) }

  const goBack = () => { resetForm(); setView('main') }

  const handleDeposit = async () => {
    const val = parseFloat(amount)
    // Flint (fiat → cNGN on-ramp) rejects amounts below ₦2,000, so enforce it here
    // too — users see the real minimum before submitting instead of a server error.
    if (!val || val < 2000) { flash('Minimum deposit is ₦2,000'); return }
    setBusy(true)
    try {
      const result = await initiateDeposit(val)
      setDepositInfo(result)
      setView('deposit-info')
      talkback('deposit_init', profile?.display_name || user?.email || 'Chief',
        `₦${val.toLocaleString('en-NG')}`)
    } catch (e: any) {
      // Never silently swap to the crypto address: that made a provider outage
      // look like the naira option had been removed. Mark the rail down, say why,
      // and return to the chooser so the user can pick crypto deliberately.
      setRampStatus({ naira: { available: false, reason: 'Our bank partner is currently unavailable' } })
      setView('deposit-choose')
      flash(e?.message || 'Naira deposit is temporarily unavailable — you can deposit crypto instead.')
    } finally {
      setBusy(false)
    }
  }

  // KYC (Sense biometric) is only offered when we're subscribed. Until then every user
  // operates at tier 1 (unverified) — usable, capped at ₦20k on withdrawals — and we
  // never push the verify flow (it 503s while Sense is off).
  const kycAvailable = process.env.NEXT_PUBLIC_KYC_ENABLED === 'true'

  const handleWithdraw = async () => {
    const verified = profile?.kyc_status === 'verified'
    const hasBvn = Boolean((profile as any)?.strails_va_account_number)
    const naira = parseFloat(amount)
    if (!naira || naira < 100) { flash('Minimum amount is ₦100'); return }
    // Tier limits: full-KYC uncapped; BVN (Naira account) up to ₦3,000,000/day (the
    // server enforces the daily total); no BVN yet capped at ₦20,000 per withdrawal.
    if (!verified && !hasBvn && naira > 20000) {
      flash('Add your BVN (get a Naira account) to withdraw more than ₦20,000.')
      return
    }
    if (!verified && hasBvn && naira > 3000000) {
      flash('Your daily withdrawal limit is ₦3,000,000. Verify your identity to withdraw more.')
      return
    }
    if (!bankCode || !accountNumber || accountNumber.length < 10) {
      flash('Enter valid bank details'); return
    }
    if (!accountHolderName.trim()) {
      flash('Enter the account holder name'); return
    }
    if (!/^\d{4}$/.test(transactionPin)) {
      flash('Enter your 4-digit PIN to withdraw'); return
    }
    if (!profile?.transaction_pin_hash) {
      flash('Set your transaction PIN in Settings first'); return
    }
    setBusy(true)
    try {
      const selectedBankName = banks.find(b => b.code === bankCode)?.name
      await initiateWithdrawal(naira, bankCode, accountNumber, transactionPin, accountHolderName, selectedBankName)
      flash('Sent! The recipient will receive NGN in their bank shortly.')
      talkback('withdrawal_done', profile?.display_name || user?.email || 'Chief', `₦${parseFloat(amount).toLocaleString('en-NG')}`)
      resetForm()
      setTransactionPin('')
      await refresh()
      setView('main')
    } catch (e: any) {
      flash(e.message || 'Withdrawal failed')
    } finally {
      setBusy(false)
    }
  }

  // Request a permanent Naira account: Strails verifies the BVN against the national
  // database and issues a dedicated NUBAN (~2 min, delivered via webhook/reconciler).
  const submitBvn = async () => {
    if (!/^\d{11}$/.test(bvn)) { flash('Enter your 11-digit BVN'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/strails/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bvn }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Could not create your account')
      setBvn('')
      flash('')
      await refresh()
    } catch (e: any) {
      flash(e?.message || 'Could not create your account')
    } finally {
      setBusy(false)
    }
  }

  const copyAccount = () => {
    if (depositInfo?.accountNumber) {
      navigator.clipboard.writeText(depositInfo.accountNumber)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  // --- Receive: pick a rail (naira bank transfer or crypto cNGN) ---
  if (view === 'deposit-choose') {
    const checking = rampStatus === null
    const nairaDown = rampStatus ? !rampStatus.naira.available : false
    return (
      <div className="b">
        <button onClick={goBack} className="back">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="h2">Receive Money</h2>
        <p className="p">Choose how you want to add money. Both are credited as cNGN (1 cNGN = ₦1).</p>

        {feedback && <div className="flash err" style={{ marginTop: 0, marginBottom: 'var(--s-3)' }}>{feedback}</div>}

        <button
          onClick={() => setView('deposit-naira')}
          className="rows" style={{ marginBottom: 'var(--s-3)', display: 'block', textAlign: 'left', width: '100%', border: '1px solid var(--line)', cursor: 'pointer' }}
        >
          <div className="dot">
            <BankIcon size={20} style={{ color: 'var(--green)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="nm">Naira bank transfer</p>
            <p className="sub">Get your own account number. Transfer from your bank anytime.</p>
            {checking && <p className="hint tight">Checking availability…</p>}
            {nairaDown && (
              <>
                <span style={{ display: 'inline-block', marginTop: 8, fontSize: 'var(--t-2xs)', fontWeight: 'var(--w-medium)', color: 'var(--amber)', background: 'color-mix(in srgb,var(--amber) 12%,transparent)', border: '1px solid color-mix(in srgb,var(--amber) 30%,transparent)', borderRadius: 'var(--r-full)', padding: '2px 8px' }}>
                  Temporarily unavailable{rampStatus?.naira.reason ? ' — ' + rampStatus.naira.reason : ''}
                </span>
                <p className="hint tight">Tap to try anyway — it may be back up.</p>
              </>
            )}
          </div>
        </button>

        <button
          onClick={() => setView('deposit-crypto')}
          className="rows" style={{ display: 'block', textAlign: 'left', width: '100%', border: '1px solid var(--line)', cursor: 'pointer' }}
        >
          <div className="dot">
            <Wallet size={20} style={{ color: 'var(--green)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="nm">Crypto deposit (cNGN)</p>
            <p className="sub">Send cNGN on Base to your address. Credited 1:1 automatically.</p>
          </div>
        </button>
      </div>
    )
  }

  // --- Receive: naira — permanent account, or BVN capture to create one ---
  if (view === 'deposit-naira') {
    const p = profile as any
    const acct = p?.strails_va_account_number as string | undefined
    const pending = p?.strails_onboard_status === 'processing' && !acct
    const verified = profile?.kyc_status === 'verified'

    return (
      <div className="b">
        <button onClick={goBack} className="back">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="h2">Naira bank transfer</h2>

        {acct ? (
          <>
            <p className="p">
              This account is permanently yours. Money sent to it is credited as cNGN automatically.
            </p>
            <div className="info" style={{ display: 'grid', gap: 'var(--s-3)' }}>
              <div>
                <p className="l">Account Number</p>
                <div className="flex items-center gap-2">
                  <p className="big num">{acct}</p>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(acct)
                      setAcctCopied(true)
                      setTimeout(() => setAcctCopied(false), 2000)
                    }}
                    style={{ color: 'var(--green)', background: 'none', border: 0, padding: 4, cursor: 'pointer' }}
                  >
                    {acctCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div>
                <p className="l">Bank</p>
                <p className="v">{p?.strails_va_bank_name}</p>
              </div>
              <div>
                <p className="l">Account Name</p>
                <p className="v">{p?.strails_va_account_name}</p>
              </div>
            </div>
            <div className="note">
              <p style={{ lineHeight: 1.5 }}>
                Transfer only from a bank account in <span className="font-semibold">your own name</span>.
                Deposits from someone else&apos;s account are automatically returned.
              </p>
            </div>
          </>
        ) : pending ? (
          <div className="mt-6 text-center">
            <CircleNotch size={24} className="animate-spin" style={{ color: 'var(--green)', margin: '0 auto 12px' }} />
            <p style={{ fontSize: 'var(--t-sm)', fontWeight: 'var(--w-semi)', color: 'var(--ink)' }}>Creating your account…</p>
            <p className="hint tight">This usually takes about 2 minutes.</p>
            <button
              onClick={async () => {
                try { await fetch('/api/strails/onboard-status') } catch { /* ignore */ }
                await refresh()
              }}
              style={{ marginTop: 'var(--s-4)', fontSize: 'var(--t-sm)', fontWeight: 'var(--w-semi)', color: 'var(--green)', background: 'none', border: 0, cursor: 'pointer' }}
            >
              Check again
            </button>
          </div>
        ) : (
          <>
            <p className="p">
              Get your own dedicated Naira account. Enter your BVN — we use it only to verify your
              identity with your bank and never store it. This unlocks tier 1 (up to ₦20,000).
            </p>
            <label className="lab">BVN</label>
            <input
              type="tel"
              inputMode="numeric"
              maxLength={11}
              value={bvn}
              onChange={(e) => setBvn(e.target.value.replace(/\D/g, ''))}
              placeholder="11-digit BVN"
              className="field num" style={{ fontSize: 'var(--t-lg)', letterSpacing: '.08em' }}
              autoFocus
            />
            {feedback && <div className="flash err">{feedback}</div>}
            <button
              onClick={submitBvn}
              disabled={busy || bvn.length !== 11}
              className="cta" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            >
              {busy ? <CircleNotch className="w-4 h-4 animate-spin" /> : <BankIcon className="w-4 h-4" />}
              Create my account
            </button>
          </>
        )}
      </div>
    )
  }

  // --- Receive: crypto (cNGN) address ---
  if (view === 'deposit-crypto') {
    return (
      <div className="b">
        <button onClick={() => setView('deposit-choose')} className="back">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="h2">Crypto Deposit</h2>
        <p className="p">Send cNGN on the Base network to the address below. Your balance is credited automatically once it confirms.</p>

        {depositAddr ? (
          <div className="info">
            <p className="l">Your cNGN address (Base network)</p>
            <div className="flex items-center gap-2 mt-1">
              <code className="code">{depositAddr}</code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(depositAddr)
                  setAddrCopied(true)
                  setTimeout(() => setAddrCopied(false), 2000)
                }}
                style={{ color: 'var(--green)', background: 'none', border: 0, padding: 4, cursor: 'pointer', flex: 'none' }}
              >
                {addrCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <p className="hint">1 cNGN = ₦1. Credited automatically, usually within 1–5 minutes.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--t-sm)', color: 'var(--muted)', padding: '24px 0' }}>
            <CircleNotch className="w-4 h-4 animate-spin" /> Generating your address…
          </div>
        )}

        <div className="note">
          <p style={{ lineHeight: 1.5 }}>
            Only send <strong>cNGN on Base</strong> to this address. Any other token or network will be lost.
          </p>
        </div>
      </div>
    )
  }

  // --- Deposit amount form ---
  if (view === 'deposit') {
    const val = parseFloat(amount) || 0
    return (
      <div className="b">
        <button onClick={goBack} className="back">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="h2">Naira Deposit</h2>
        <p className="p">Send naira from your bank. Funds are credited as cNGN (1 cNGN = ₦1).</p>

        <div style={{ marginBottom: 'var(--s-5)', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: '10px 12px' }}>
          <p style={{ fontSize: 'var(--t-xs)', fontWeight: 'var(--w-medium)', color: 'var(--muted)' }}>Provider is selected automatically for best rate and uptime.</p>
        </div>

        <div>
          <label className="lab">Amount (₦)</label>
          <div className="relative">
            <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--faint)', fontWeight: 'var(--w-medium)' }}>₦</span>
            <input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="e.g. 5000"
              className="field num" style={{ fontSize: 'var(--t-lg)', paddingLeft: 30 }}
              autoFocus
            />
          </div>
          {val > 0 ? (
            <p className="hint">≈ {val.toLocaleString('en-NG', { maximumFractionDigits: 0 })} cNGN</p>
          ) : (
            <p className="hint">Minimum deposit ₦2,000</p>
          )}
        </div>

        {feedback && <div className="flash err">{feedback}</div>}

        <button
          onClick={handleDeposit}
          disabled={busy || !amount}
          className="cta" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          {busy ? <CircleNotch className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
          Continue
        </button>
      </div>
    )
  }

  // --- Deposit bank info (post-API) ---
  if (view === 'deposit-info' && depositInfo) {
    return (
      <div className="b">
        <button onClick={goBack} className="back">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="h2">Complete Transfer</h2>
        <p className="p">
          Send the exact amount below. Your cNGN balance will be credited automatically once confirmed.
        </p>

        <div className="info" style={{ display: 'grid', gap: 'var(--s-4)' }}>
          <div>
            <p className="l">Amount</p>
            <p className="big num">
              ₦{parseInt(amount).toLocaleString()}
            </p>
          </div>
          {/* Xend: show wallet address */}
          {depositInfo.walletAddress && (
            <div>
              <p className="l">Wallet Address ({depositInfo.network || 'Base'})</p>
              <div className="flex items-center gap-2">
                <code className="code">{depositInfo.walletAddress}</code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(depositInfo.walletAddress!)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                  style={{ color: 'var(--green)', background: 'none', border: 0, padding: 4, cursor: 'pointer', flex: 'none' }}
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              {depositInfo.currency && (
                <p className="hint">Currency: {depositInfo.currency}</p>
              )}
            </div>
          )}
          {/* FlintAPI: show bank details */}
          {depositInfo.bankName && (
            <div>
              <p className="l">Bank</p>
              <p className="v">{depositInfo.bankName}</p>
            </div>
          )}
          {depositInfo.accountNumber && (
            <div>
              <p className="l">Account Number</p>
              <div className="flex items-center gap-2">
                <p className="big num">{depositInfo.accountNumber}</p>
                <button onClick={copyAccount} style={{ color: 'var(--green)', background: 'none', border: 0, padding: 4, cursor: 'pointer' }}>
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}
          {depositInfo.accountName && (
            <div>
              <p className="l">Account Name</p>
              <p className="v">{depositInfo.accountName}</p>
            </div>
          )}
          {/* Fallback when no fiat bank account is returned: deposit cNGN to the
              user's own Base address — auto-credited 1:1 by the deposit scanner. */}
          {!depositInfo.walletAddress && !depositInfo.bankName && !depositInfo.accountNumber && depositAddr && (
            <div>
              <p className="l">Send cNGN to this address (Base network)</p>
              <div className="flex items-center gap-2">
                <code className="code">{depositAddr}</code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(depositAddr)
                    setAddrCopied(true)
                    setTimeout(() => setAddrCopied(false), 2000)
                  }}
                  style={{ color: 'var(--green)', background: 'none', border: 0, padding: 4, cursor: 'pointer', flex: 'none' }}
                >
                  {addrCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <p className="hint">
                Send exactly {amount ? parseInt(amount).toLocaleString() : ''} cNGN (1 cNGN = ₦1). Credited automatically once the transfer confirms.
              </p>
            </div>
          )}
        </div>

        <div className="note">
          <p style={{ lineHeight: 1.5 }}>
            After transferring, your deposit will be automatically confirmed and your cNGN balance credited. This usually takes 1–5 minutes.
          </p>
        </div>

        <button
          onClick={() => { goBack(); refresh() }}
          className="cta" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          I&apos;ve Sent the Money
        </button>
      </div>
    )
  }

  // --- Withdraw form ---
  if (view === 'withdraw') {
    return (
      <div className="b">
        <button onClick={goBack} className="back">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="h2">Send Money</h2>
        <p className="p">Send naira from your cNGN balance to any Nigerian bank account.</p>

        {profile?.kyc_status !== 'verified' && (
          (profile as any)?.strails_va_account_number ? (
            <div className="info" style={{ marginBottom: 'var(--s-4)' }}>
              <p className="l">Tier 1 · ₦3,000,000 daily limit</p>
              <p className="hint">
                You can withdraw up to ₦3,000,000 per day.{kycAvailable ? ' Full verification removes the limit.' : ''}
              </p>
              {kycAvailable && (
                <button
                  onClick={onStartKyc}
                  style={{ marginTop: 8, fontSize: 'var(--t-xs)', fontWeight: 'var(--w-semi)', background: 'var(--green)', color: '#fff', border: 0, padding: '6px 12px', borderRadius: 'var(--r-sm)', cursor: 'pointer' }}
                >
                  Verify identity
                </button>
              )}
            </div>
          ) : (
            <div className="note" style={{ marginTop: 0, marginBottom: 'var(--s-4)' }}>
              <p style={{ fontWeight: 'var(--w-semi)' }}>₦20,000 limit</p>
              <p style={{ marginTop: 4 }}>
                Add your BVN to get a Naira account and raise your limit to ₦3,000,000 per day.
              </p>
            </div>
          )
        )}

        <div style={{ marginBottom: 'var(--s-5)', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: '10px 12px' }}>
          <p style={{ fontSize: 'var(--t-xs)', fontWeight: 'var(--w-medium)', color: 'var(--muted)' }}>Provider is selected automatically for best effective rate and uptime.</p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="lab">Amount (₦)</label>
            <input
              type="number"
              inputMode="numeric"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="e.g. 5000"
              className="field num" style={{ fontSize: 'var(--t-lg)' }}
              autoFocus
            />
            {amount && parseFloat(amount) >= 100 && (
              <p className="hint tight">≈ {parseFloat(amount).toLocaleString('en-NG')} cNGN will be debited</p>
            )}
          </div>

          <div>
            <label className="lab">Bank</label>
            {banksLoading ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--t-sm)', color: 'var(--muted)', padding: '12px 0' }}><CircleNotch className="w-4 h-4 animate-spin" /> Loading banks...</div>
            ) : banksError ? (
              <div style={{ fontSize: 'var(--t-xs)', fontWeight: 'var(--w-medium)', color: 'var(--neg)', padding: '8px 0' }}>Could not load banks. Please retry.</div>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <input
                    type="text"
                    value={bankSearch}
                    onChange={e => { setBankSearch(e.target.value); setBankCode('') }}
                    placeholder="Search bank name..."
                    className="field"
                  />
                </div>
                {bankSearch.length > 0 && (
                  <div style={{ maxHeight: 192, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', background: 'var(--surface)', boxShadow: 'var(--e-1)' }}>
                    {banks
                      .filter(b => b.name.toLowerCase().includes(bankSearch.toLowerCase()))
                      .slice(0, 10)
                      .map(b => (
                        <button
                          key={b.code}
                          type="button"
                          onClick={() => { setBankCode(b.code); setBankSearch(b.name) }}
                          style={{
                            width: '100%', textAlign: 'left', padding: '10px 14px', border: 0, cursor: 'pointer',
                            fontFamily: 'inherit', fontSize: 'var(--t-sm)',
                            borderTop: '1px solid var(--line-2)',
                            fontWeight: bankCode === b.code ? 'var(--w-semi)' : 'var(--w-medium)',
                            color: bankCode === b.code ? 'var(--green)' : 'var(--ink)',
                            background: bankCode === b.code ? 'var(--green-soft)' : 'transparent',
                          }}
                        >
                          {b.name}
                        </button>
                      ))}
                    {banks.filter(b => b.name.toLowerCase().includes(bankSearch.toLowerCase())).length === 0 && (
                      <p style={{ padding: '12px 14px', fontSize: 'var(--t-sm)', color: 'var(--muted)' }}>No banks found</p>
                    )}
                  </div>
                )}
                {!bankSearch && (
                  <div className="relative">
                    <BankIcon size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--faint)', pointerEvents: 'none' }} />
                    <select
                      value={bankCode}
                      onChange={e => { setBankCode(e.target.value); setBankSearch(banks.find(b => b.code === e.target.value)?.name || '') }}
                      className="field" style={{ paddingLeft: 38, paddingRight: 30, appearance: 'none' }}
                    >
                      <option value="">— or select from list —</option>
                      {banks.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
                    </select>
                    <CaretDown size={16} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--faint)', pointerEvents: 'none' }} />
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="lab">Account Number</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={10}
              value={accountNumber}
              onChange={e => setAccountNumber(e.target.value.replace(/\D/g, ''))}
              placeholder="0123456789"
              className="field"
            />
          </div>

          <div>
            <label className="lab">Account Holder Name</label>
            <div className="relative">
              <input
                type="text"
                value={accountHolderName}
                onChange={e => { setAccountHolderName(e.target.value); setNameResolved(false); setResolveError('') }}
                placeholder={resolvingName ? 'Checking account…' : 'Full name on bank account'}
                readOnly={nameResolved}
                autoComplete="name"
                className="field"
                style={{ paddingRight: 38, borderColor: nameResolved ? 'var(--green)' : 'var(--line)' }}
              />
              {resolvingName && <CircleNotch size={16} className="animate-spin" style={{ color: 'var(--faint)', position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)' }} />}
              {nameResolved && !resolvingName && <Check size={16} style={{ color: 'var(--green)', position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)' }} />}
            </div>
            {resolveError && <p className="hint" style={{ color: 'var(--amber)' }}>{resolveError}</p>}
          </div>

          <div>
            <label className="lab">Transaction PIN</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={transactionPin}
              onChange={e => setTransactionPin(e.target.value.replace(/\D/g, ''))}
              placeholder="****"
              className="field num" style={{ letterSpacing: '.35em' }}
            />
          </div>
        </div>

        {parseFloat(amount) > 0 && (() => {
          const net = parseFloat(amount)
          const networkFee = Math.max(0, Math.round(net / 0.99) - net) // Flipeet ~1% spread
          const ourFee = Math.round(net * 0.015)                       // PawaSave 1.5%
          const total = net + networkFee + ourFee
          return (
            <div className="breakdown">
              <div className="r"><span>Recipient gets</span><span className="num" style={{ color: 'var(--ink)', fontWeight: 'var(--w-semi)' }}>₦{net.toLocaleString('en-NG')}</span></div>
              <div className="r"><span>Network fee (~1%)</span><span>₦{networkFee.toLocaleString('en-NG')}</span></div>
              <div className="r"><span>PawaSave fee (1.5%)</span><span>₦{ourFee.toLocaleString('en-NG')}</span></div>
              <div className="tot"><span>Total from wallet</span><span>₦{total.toLocaleString('en-NG')}</span></div>
            </div>
          )
        })()}

        {feedback && <div className="flash err">{feedback}</div>}

        <button
          onClick={handleWithdraw}
          disabled={busy || !amount || !bankCode || accountNumber.length < 10 || !accountHolderName.trim() || transactionPin.length < 4}
          className="cta" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          {busy ? <CircleNotch className="w-4 h-4 animate-spin" /> : <ArrowUpRight className="w-4 h-4" />}
          Send Money
        </button>
      </div>
    )
  }

  // --- Main view ---
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const firstName = (profile?.display_name || user?.email || 'there').split(/[ @]/)[0]
  const initials = (profile?.display_name || user?.email || 'PS')
    .split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase()
  const earnedKobo = microUsdcToKobo(wallet.cngn_yield_earned_micro || 0)

  // Group recent activity by day for the feed.
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
  const startYest = new Date(startToday); startYest.setDate(startYest.getDate() - 1)
  const dayLabel = (ts: string) => {
    const t = new Date(ts).getTime()
    if (t >= startToday.getTime()) return 'Today'
    if (t >= startYest.getTime()) return 'Yesterday'
    return 'Earlier'
  }
  const groups: { label: string; items: Transaction[] }[] = []
  recentTxs.forEach((tx) => {
    const label = dayLabel(tx.created_at)
    const g = groups.find((x) => x.label === label)
    if (g) g.items.push(tx); else groups.push({ label, items: [tx] })
  })

  return (
    <div className="b">
      <div className="greet">
        <div>
          <div className="hi">{greeting}</div>
          <div className="nm">{firstName}</div>
        </div>
        <div className="av">{initials}</div>
      </div>

      {/* Account card */}
      <div className="acct rise">
        <div className="acct-top">
          <span className="acct-lab">Total balance</span>
          <span className="acct-chip">cNGN</span>
        </div>
        <div className="acct-bal num">{formatNaira(totalKobo)}</div>
        {earnedKobo > 0 && <div className="acct-earn">↑ {formatNaira(earnedKobo)} earned in savings</div>}
        <div className="acct-sub">
          <div><div className="l">Available</div><div className="v num">{formatNaira(wallet.naira_balance_kobo)}</div></div>
          <div><div className="l">Savings</div><div className="v num">{formatNaira(savingsKobo + cngnKobo)}</div></div>
        </div>
        <div className="acct-actions">
          <button className="ab" onClick={() => setView('withdraw')}>
            <ArrowUpRight className="w-4 h-4" /> Send
          </button>
          <button className="ab solid" onClick={() => setView('deposit-choose')}>
            <ArrowDownLeft className="w-4 h-4" /> Receive
          </button>
        </div>
      </div>

      {feedback && <div className="flash ok">{feedback}</div>}

      {/* Activity feed */}
      <div className="sect">
        <span className="h">Activity</span>
        <button
          className="m"
          onClick={() => setShowStatement(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 0, fontFamily: 'inherit', cursor: 'pointer', color: 'inherit' }}
        >
          <FileText size={14} />
          Statement
        </button>
      </div>
      {recentTxs.length === 0 ? (
        <div className="empty">
          <div className="eh">No activity yet</div>
          <div className="es">Add money with Receive to get started</div>
        </div>
      ) : (
        <div className="feedcard rise">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="daylab">{g.label}</div>
              {g.items.map((tx) => {
                const credit = tx.direction === 'credit'
                return (
                  <button
                    key={tx.id}
                    onClick={() => setSelectedTx(tx)}
                    className={`tx${credit ? ' inn' : ''}`}
                    style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, fontFamily: 'inherit', cursor: 'pointer' }}
                  >
                    <span className="ic">{credit ? <ArrowDownLeft /> : <ArrowUpRight />}</span>
                    <div className="mid">
                      <div className="nm">{cleanDescription(tx.description) || (credit ? 'Received' : 'Sent')}</div>
                      <div className="sub">{credit ? 'Credit' : 'Debit'}</div>
                    </div>
                    <div className="rt">
                      <div className={`amt num${credit ? ' pos' : ''}`}>{credit ? '+' : '−'}{formatNaira(tx.amount_kobo)}</div>
                      <div className={`st${tx.status === 'pending' ? ' pend' : ''}`}>
                        {tx.status === 'pending' ? 'Processing' : timeAgo(tx.created_at)}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {selectedTx && <TxDetail tx={selectedTx} onClose={() => setSelectedTx(null)} />}
      {showStatement && <StatementSheet email={user?.email} onClose={() => setShowStatement(false)} flash={flash} />}
    </div>
  )
}

/** Statement sheet — pick a period, then print/save-as-PDF or email a branded statement. */
function StatementSheet({ email, onClose, flash }: { email?: string; onClose: () => void; flash: (m: string) => void }) {
  const [period, setPeriod] = useState<'30d' | '90d' | '6m' | 'all'>('90d')
  const [busy, setBusy] = useState<'view' | 'email' | null>(null)

  const periods: { id: typeof period; label: string }[] = [
    { id: '30d', label: '30 days' },
    { id: '90d', label: '90 days' },
    { id: '6m', label: '6 months' },
    { id: 'all', label: 'All time' },
  ]

  const run = async (delivery: 'view' | 'email') => {
    if (busy) return
    setBusy(delivery)
    try {
      const res = await fetch('/api/statement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period, delivery }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { flash(data?.error || 'Could not generate statement'); return }

      if (delivery === 'email') {
        flash(`Statement sent to ${data.email || 'your email'}`)
        onClose()
      } else {
        const w = window.open('', '_blank')
        if (!w) { flash('Allow pop-ups to open the statement'); return }
        w.document.open(); w.document.write(data.html); w.document.close()
        w.focus()
        setTimeout(() => { try { w.print() } catch { /* user can print manually */ } }, 700)
        onClose()
      }
    } catch {
      flash('Could not generate statement')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 80, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} className="rise" style={{ width: '100%', maxWidth: 512, background: 'var(--surface)', borderRadius: '22px 22px 0 0', padding: '18px 18px calc(24px + var(--safe-bottom))' }}>
        <div style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--line)', margin: '0 auto 16px' }} />
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--ink)' }}>Account statement</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>
          A branded statement with your logo{email ? `, emailed to ${email}` : ''} or ready to print / save as PDF.
        </div>

        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '18px 0 8px', fontWeight: 600 }}>Period</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
          {periods.map((p) => (
            <button
              key={p.id}
              onClick={() => setPeriod(p.id)}
              style={{
                padding: '10px 6px', borderRadius: 12, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                border: period === p.id ? '1.5px solid var(--green)' : '1px solid var(--line-2)',
                background: period === p.id ? 'var(--green-soft)' : 'var(--surface)',
                color: period === p.id ? 'var(--green)' : 'var(--ink)',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button
            onClick={() => run('view')}
            disabled={!!busy}
            style={{ flex: 1, padding: '13px', borderRadius: 13, fontWeight: 650, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', border: '1.5px solid var(--green)', background: 'var(--surface)', color: 'var(--green)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, opacity: busy ? 0.7 : 1 }}
          >
            {busy === 'view' ? <CircleNotch className="w-4 h-4 animate-spin" /> : null} Print / PDF
          </button>
          <button
            onClick={() => run('email')}
            disabled={!!busy}
            className="cta"
            style={{ flex: 1, margin: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, opacity: busy ? 0.7 : 1 }}
          >
            {busy === 'email' ? <CircleNotch className="w-4 h-4 animate-spin" /> : null} Email to me
          </button>
        </div>
      </div>
    </div>
  )
}

/** Transaction detail sheet — full amount, status, time, reference. */
function TxDetail({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const credit = tx.direction === 'credit'
  const title = (tx.type || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  const dt = new Date(tx.created_at)
  const ref = (tx as any).reference as string | undefined
  const meta = (tx as any).metadata as Record<string, any> | null | undefined
  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '11px 0', borderTop: '1px solid var(--line-2)' }}>
      <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{k}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', textAlign: 'right', wordBreak: 'break-word' }}>{v}</span>
    </div>
  )
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 80, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} className="rise" style={{ width: '100%', maxWidth: 512, background: 'var(--surface)', borderRadius: '22px 22px 0 0', padding: '18px 18px calc(24px + var(--safe-bottom))', maxHeight: '85dvh', overflowY: 'auto' }}>
        <div style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--line)', margin: '0 auto 16px' }} />
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, margin: '0 auto 10px', display: 'grid', placeItems: 'center', background: 'var(--green-soft)', color: 'var(--green)' }}>
            {credit ? <ArrowDownLeft /> : <ArrowUpRight />}
          </div>
          <div className="num" style={{ fontSize: 30, fontWeight: 700, color: credit ? 'var(--pos)' : 'var(--ink)' }}>{credit ? '+' : '−'}{formatNaira(tx.amount_kobo)}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>{cleanDescription(tx.description) || title}</div>
        </div>
        <div style={{ marginTop: 16 }}>
          <Row k="Type" v={title || (credit ? 'Credit' : 'Debit')} />
          <Row k="Status" v={<span style={{ color: tx.status === 'pending' ? 'var(--amber)' : tx.status === 'completed' ? 'var(--green)' : 'var(--ink)', textTransform: 'capitalize' }}>{tx.status === 'pending' ? 'Processing' : tx.status}</span>} />
          <Row k="Direction" v={credit ? 'Money in' : 'Money out'} />
          {meta?.bank_name && <Row k="To bank" v={meta.bank_name} />}
          {meta?.account_name && <Row k="Account name" v={meta.account_name} />}
          {meta?.account_number && <Row k="Account no" v={<span className="num">{meta.account_number}</span>} />}
          {meta?.sender_name && <Row k="From" v={meta.sender_name} />}
          {meta?.sender_account && <Row k="Sender account" v={<span className="num">{meta.sender_account}</span>} />}
          <Row k="Date" v={dt.toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })} />
          {ref && <Row k="Reference" v={<span style={{ fontSize: 11 }}>{ref}</span>} />}
          <Row k="Transaction ID" v={<span style={{ fontSize: 11 }}>{tx.id.slice(0, 18)}…</span>} />
        </div>
        <button className="cta" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}
