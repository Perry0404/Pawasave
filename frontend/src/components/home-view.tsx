'use client'

import { useState, useEffect } from 'react'
import { formatNaira, formatUsdc, microUsdcToKobo, getRate, timeAgo } from '@/lib/format'
import { initiateDeposit, initiateWithdrawal, getBanks, type RampResult, type Bank } from '@/lib/flint'
import { talkback } from '@/lib/voice'
import { ArrowUpRight, ArrowDownLeft, Vault, TrendingUp, Wallet, Plus, Minus, CreditCard, Loader2, ArrowLeft, Copy, Check, ChevronDown, Building2 } from 'lucide-react'
import type { Profile, Wallet as WalletType, Transaction } from '@/lib/types'
import type { User } from '@supabase/supabase-js'

type View = 'main' | 'deposit' | 'deposit-info' | 'withdraw'

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
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [amount, setAmount] = useState('')
  const [depositInfo, setDepositInfo] = useState<RampResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [addrCopied, setAddrCopied] = useState(false)
  const [liveRate, setLiveRate] = useState<number>(getRate())

  // Withdraw state
  const [banks, setBanks] = useState<Bank[]>([])
  const [bankCode, setBankCode] = useState('')
  const [bankSearch, setBankSearch] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [accountHolderName, setAccountHolderName] = useState('')
  const [banksLoading, setBanksLoading] = useState(false)
  const [banksError, setBanksError] = useState(false)
  const [transactionPin, setTransactionPin] = useState('')

  useEffect(() => {
    if (view === 'withdraw' && banks.length === 0) {
      setBanksLoading(true)
      setBanksError(false)
      getBanks()
        .then(b => { setBanks(b); setBanksLoading(false) })
        .catch(() => { setBanksLoading(false); setBanksError(true) })
    }
  }, [view, banks.length])

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

  if (!wallet) return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>

  const rate = liveRate
  const savingsKobo = microUsdcToKobo(wallet.usdc_balance_micro, rate)
  const cngnKobo = microUsdcToKobo(wallet.cngn_pool_micro || 0, rate)
  const totalKobo = wallet.naira_balance_kobo + savingsKobo + cngnKobo
  const recentTxs = transactions.slice(0, 6)

  const flash = (msg: string) => { setFeedback(msg); setTimeout(() => setFeedback(''), 4000) }

  const resetForm = () => { setAmount(''); setDepositInfo(null); setBankCode(''); setBankSearch(''); setAccountNumber(''); setAccountHolderName(''); setCopied(false) }

  const goBack = () => { resetForm(); setView('main') }

  const handleDeposit = async () => {
    const naira = parseFloat(amount)
    if (!naira || naira < 100) { flash('Minimum amount is ₦100'); return }
    setBusy(true)
    try {
      const result = await initiateDeposit(naira)
      setDepositInfo(result)
      setView('deposit-info')
      talkback('deposit_init', profile?.display_name || user?.email || 'Chief', `₦${naira.toLocaleString('en-NG')}`)
    } catch (e: any) {
      flash(e.message || 'Deposit failed')
    } finally {
      setBusy(false)
    }
  }

  const handleWithdraw = async () => {
    if (profile?.kyc_status !== 'verified') {
      flash('KYC is required before withdrawal')
      onStartKyc()
      return
    }
    const naira = parseFloat(amount)
    if (!naira || naira < 100) { flash('Minimum amount is ₦100'); return }
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
      await initiateWithdrawal(naira, bankCode, accountNumber, transactionPin, accountHolderName)
      flash('Sent! The recipient will receive NGN in their bank shortly.')
      talkback('withdrawal_done', profile?.display_name || user?.email || 'Chief', `₦${parseFloat(amount).toLocaleString('en-NG')}`)
      resetForm()
      setTransactionPin('')
      setView('main')
      refresh()
    } catch (e: any) {
      flash(e.message || 'Withdrawal failed')
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

  // --- Deposit amount form ---
  if (view === 'deposit') {
    return (
      <div className="px-4 pt-5">
        <button onClick={goBack} className="flex items-center gap-1 text-sm text-slate-500 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="text-lg font-bold text-slate-900 mb-1">Receive Money</h2>
        <p className="text-sm text-slate-400 mb-4">Send naira via bank transfer. It auto-converts to USDC and saves in your vault.</p>

        <div className="mb-5 bg-slate-100 rounded-xl px-3 py-2.5">
          <p className="text-xs text-slate-600">Provider is selected automatically for best effective rate and uptime.</p>
        </div>

        <div>
          <label className="text-xs text-slate-500 block mb-1.5">Amount (₦)</label>
          <input
            type="number"
            inputMode="numeric"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="e.g. 5000"
            className="w-full px-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
            autoFocus
          />
          {amount && parseFloat(amount) >= 100 && (
            <p className="text-xs text-slate-400 mt-2">≈ ${(parseFloat(amount) / rate).toFixed(2)} USDC at ₦{rate}/USD</p>
          )}
        </div>

        {feedback && <div className="mt-3 px-4 py-2.5 rounded-xl text-sm font-medium bg-red-50 text-red-700">{feedback}</div>}

        <button
          onClick={handleDeposit}
          disabled={busy || !amount}
          className="w-full mt-6 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98] disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
          Continue
        </button>
      </div>
    )
  }

  // --- Deposit bank info (post-API) ---
  if (view === 'deposit-info' && depositInfo) {
    return (
      <div className="px-4 pt-5">
        <button onClick={goBack} className="flex items-center gap-1 text-sm text-slate-500 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="text-lg font-bold text-slate-900 mb-1">Complete Transfer</h2>
        <p className="text-sm text-slate-400 mb-5">
          {depositInfo.provider === 'xend'
            ? 'Send crypto to the wallet address below. Your vault will be credited automatically.'
            : 'Send the exact amount below. Your vault will be credited automatically.'}
        </p>

        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 space-y-4">
          <div>
            <p className="text-[11px] text-emerald-600 font-medium">Amount</p>
            <p className="text-2xl font-bold text-emerald-800">₦{parseInt(amount).toLocaleString()}</p>
          </div>
          {/* Xend: show wallet address */}
          {depositInfo.walletAddress && (
            <div>
              <p className="text-[11px] text-emerald-600 font-medium">Wallet Address ({depositInfo.network || 'Base'})</p>
              <div className="flex items-center gap-2">
                <code className="text-xs font-bold text-emerald-900 break-all">{depositInfo.walletAddress}</code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(depositInfo.walletAddress!)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                  className="text-emerald-600 hover:text-emerald-800 transition p-1 flex-shrink-0"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              {depositInfo.currency && (
                <p className="text-[11px] text-emerald-500 mt-1">Currency: {depositInfo.currency}</p>
              )}
            </div>
          )}
          {/* FlintAPI: show bank details */}
          {depositInfo.bankName && (
            <div>
              <p className="text-[11px] text-emerald-600 font-medium">Bank</p>
              <p className="text-sm font-semibold text-emerald-900">{depositInfo.bankName}</p>
            </div>
          )}
          {depositInfo.accountNumber && (
            <div>
              <p className="text-[11px] text-emerald-600 font-medium">Account Number</p>
              <div className="flex items-center gap-2">
                <p className="text-lg font-bold text-emerald-900 tracking-wider">{depositInfo.accountNumber}</p>
                <button onClick={copyAccount} className="text-emerald-600 hover:text-emerald-800 transition p-1">
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}
          {depositInfo.accountName && (
            <div>
              <p className="text-[11px] text-emerald-600 font-medium">Account Name</p>
              <p className="text-sm font-semibold text-emerald-900">{depositInfo.accountName}</p>
            </div>
          )}
        </div>

        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <p className="text-xs text-amber-700 leading-relaxed">
            After transferring, your deposit will be automatically confirmed and your USDC vault credited. This usually takes 1–5 minutes.
          </p>
        </div>

        <button
          onClick={() => { goBack(); refresh() }}
          className="w-full mt-6 bg-slate-900 hover:bg-slate-800 text-white font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98]"
        >
          I&apos;ve Sent the Money
        </button>
      </div>
    )
  }

  // --- Withdraw form ---
  if (view === 'withdraw') {
    return (
      <div className="px-4 pt-5">
        <button onClick={goBack} className="flex items-center gap-1 text-sm text-slate-500 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="text-lg font-bold text-slate-900 mb-1">Send Money</h2>
        <p className="text-sm text-slate-400 mb-4">Send naira from your USDC vault to any Nigerian bank account.</p>

        {profile?.kyc_status !== 'verified' && (
          <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <p className="text-xs text-amber-800 font-medium">KYC Required for Withdrawal</p>
            <p className="text-xs text-amber-700 mt-1">Complete KYC before sending money.</p>
            <button
              onClick={onStartKyc}
              className="mt-2 text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg transition"
            >
              Complete KYC
            </button>
          </div>
        )}

        <div className="mb-5 bg-slate-100 rounded-xl px-3 py-2.5">
          <p className="text-xs text-slate-600">Provider is selected automatically for best effective rate and uptime.</p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs text-slate-500 block mb-1.5">Amount (₦)</label>
            <input
              type="number"
              inputMode="numeric"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="e.g. 5000"
              className="w-full px-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
              autoFocus
            />
            {amount && parseFloat(amount) >= 100 && (
              <p className="text-xs text-slate-400 mt-1">≈ ${(parseFloat(amount) / rate).toFixed(2)} USDC will be debited</p>
            )}
          </div>

          <div>
            <label className="text-xs text-slate-500 block mb-1.5">Bank</label>
            {banksLoading ? (
              <div className="flex items-center gap-2 py-3 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading banks...</div>
            ) : banksError ? (
              <div className="text-xs text-red-500 py-2">Could not load banks. Please retry.</div>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <input
                    type="text"
                    value={bankSearch}
                    onChange={e => { setBankSearch(e.target.value); setBankCode('') }}
                    placeholder="Search bank name..."
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                {bankSearch.length > 0 && (
                  <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-xl bg-white shadow-sm divide-y divide-slate-100">
                    {banks
                      .filter(b => b.name.toLowerCase().includes(bankSearch.toLowerCase()))
                      .slice(0, 10)
                      .map(b => (
                        <button
                          key={b.code}
                          type="button"
                          onClick={() => { setBankCode(b.code); setBankSearch(b.name) }}
                          className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-50 transition ${bankCode === b.code ? 'font-semibold text-emerald-700 bg-emerald-50' : 'text-slate-800'}`}
                        >
                          {b.name}
                        </button>
                      ))}
                    {banks.filter(b => b.name.toLowerCase().includes(bankSearch.toLowerCase())).length === 0 && (
                      <p className="px-4 py-3 text-sm text-slate-400">No banks found</p>
                    )}
                  </div>
                )}
                {!bankSearch && (
                  <div className="relative">
                    <Building2 className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                    <select
                      value={bankCode}
                      onChange={e => { setBankCode(e.target.value); setBankSearch(banks.find(b => b.code === e.target.value)?.name || '') }}
                      className="w-full pl-10 pr-8 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    >
                      <option value="">— or select from list —</option>
                      {banks.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="text-xs text-slate-500 block mb-1.5">Account Number</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={10}
              value={accountNumber}
              onChange={e => setAccountNumber(e.target.value.replace(/\D/g, ''))}
              placeholder="0123456789"
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div>
            <label className="text-xs text-slate-500 block mb-1.5">Account Holder Name</label>
            <input
              type="text"
              value={accountHolderName}
              onChange={e => setAccountHolderName(e.target.value)}
              placeholder="Full name on bank account"
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div>
            <label className="text-xs text-slate-500 block mb-1.5">Transaction PIN</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={transactionPin}
              onChange={e => setTransactionPin(e.target.value.replace(/\D/g, ''))}
              placeholder="****"
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm tracking-[0.35em] focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
        </div>

        {feedback && <div className="mt-3 px-4 py-2.5 rounded-xl text-sm font-medium bg-red-50 text-red-700">{feedback}</div>}

        <button
          onClick={handleWithdraw}
          disabled={busy || !amount || !bankCode || accountNumber.length < 10 || !accountHolderName.trim() || transactionPin.length < 4}
          className="w-full mt-6 bg-orange-500 hover:bg-orange-600 text-white font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98] disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUpRight className="w-4 h-4" />}
          Send Money
        </button>
      </div>
    )
  }

  // --- Main view ---
  return (
    <div className="px-4 pt-5">
      {/* Balance Card */}
      <div className="bg-gradient-to-br from-emerald-600 to-emerald-800 rounded-2xl p-5 text-white">
        <p className="text-emerald-200 text-xs font-medium">Total Balance</p>
        <p className="text-[2rem] font-bold mt-0.5 tracking-tight">{formatNaira(totalKobo)}</p>
        <div className="flex gap-6 mt-4 text-sm">
          <div>
            <p className="text-emerald-300 text-[11px]">Available</p>
            <p className="font-semibold">{formatNaira(wallet.naira_balance_kobo)}</p>
          </div>
          <div>
            <p className="text-emerald-300 text-[11px]">USDC Vault</p>
            <p className="font-semibold">{formatUsdc(wallet.usdc_balance_micro)}</p>
          </div>
          {(wallet.cngn_pool_micro || 0) > 0 && (
            <div>
              <p className="text-emerald-300 text-[11px]">cNGN Pool</p>
              <p className="font-semibold">{formatNaira(cngnKobo)}</p>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-3 text-emerald-300 text-[11px]">
          <TrendingUp className="w-3 h-3" />
          <span>Rate: ₦{rate.toLocaleString()}/USD</span>
        </div>
      </div>

      {/* Personal Deposit Address */}
      {wallet.deposit_address && (
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 mt-3">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[11px] text-slate-500 font-medium">Your Deposit Address (Base L2)</p>
            <button
              onClick={() => {
                navigator.clipboard.writeText(wallet.deposit_address!)
                setAddrCopied(true)
                setTimeout(() => setAddrCopied(false), 2000)
              }}
              className="text-emerald-600 hover:text-emerald-700 transition p-0.5"
            >
              {addrCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
          <code className="text-xs text-slate-700 break-all leading-relaxed">{wallet.deposit_address}</code>
        </div>
      )}

      {/* Quick Actions */}
      <div className="grid grid-cols-3 gap-3 mt-5">
        <button
          onClick={() => setView('deposit')}
          className="flex flex-col items-center gap-1.5 py-4 rounded-xl border border-slate-200 bg-white active:bg-slate-50 transition"
        >
          <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
            <ArrowDownLeft className="w-5 h-5" />
          </div>
          <span className="text-xs font-medium text-slate-700">Receive</span>
        </button>

        <button
          onClick={() => setView('withdraw')}
          className="flex flex-col items-center gap-1.5 py-4 rounded-xl border border-slate-200 bg-white active:bg-slate-50 transition"
        >
          <div className="w-10 h-10 rounded-full bg-orange-100 text-orange-500 flex items-center justify-center">
            <ArrowUpRight className="w-5 h-5" />
          </div>
          <span className="text-xs font-medium text-slate-700">Send</span>
        </button>

        <button
          onClick={() => onNavigateVault?.()}
          className="flex flex-col items-center gap-1.5 py-4 rounded-xl border border-slate-200 bg-white active:bg-slate-50 transition"
        >
          <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center">
            <Vault className="w-5 h-5" />
          </div>
          <span className="text-xs font-medium text-slate-700">Save</span>
        </button>
      </div>

      {/* Feedback */}
      {feedback && (
        <div className="mt-3 px-4 py-2.5 rounded-xl text-sm font-medium bg-emerald-50 text-emerald-700">
          {feedback}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 mt-5">
        <div className="bg-white border border-slate-100 rounded-xl p-4">
          <p className="text-[11px] text-slate-400">Total Saved</p>
          <p className="text-lg font-bold text-slate-900 mt-0.5">{formatNaira(wallet.total_saved_kobo)}</p>
        </div>
        <div className="bg-white border border-slate-100 rounded-xl p-4">
          <p className="text-[11px] text-slate-400">Total Withdrawn</p>
          <p className="text-lg font-bold text-slate-900 mt-0.5">{formatNaira(wallet.total_withdrawn_kobo)}</p>
        </div>
      </div>

      {/* Recent Transactions */}
      <div className="mt-6 mb-4">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Recent Activity</h3>
        {recentTxs.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-100 p-8 text-center">
            <Wallet className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-400">No transactions yet</p>
            <p className="text-xs text-slate-300 mt-1">Make a deposit to get started</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-100 divide-y divide-slate-50">
            {recentTxs.map((tx) => (
              <div key={tx.id} className="flex items-center gap-3 px-4 py-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  tx.direction === 'credit' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'
                }`}>
                  {tx.direction === 'credit' ? <Plus className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-800 truncate">{tx.description}</p>
                  <p className="text-[11px] text-slate-400">
                    {timeAgo(tx.created_at)}
                    {tx.status === 'pending' && <span className="ml-1 text-amber-500 font-medium">pending</span>}
                  </p>
                </div>
                <span className={`text-sm font-semibold tabular-nums ${
                  tx.direction === 'credit' ? 'text-emerald-600' : 'text-slate-700'
                }`}>
                  {tx.direction === 'credit' ? '+' : '-'}{formatNaira(tx.amount_kobo)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
