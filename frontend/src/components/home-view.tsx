'use client';

import { useState } from 'react';
import { useStore, microUsdcToKobo } from '@/lib/store';
import { formatNaira, formatUsdc, formatCompact, timeAgo } from '@/lib/format';
import { ArrowDownLeft, ArrowUpRight, Vault, TrendingUp, Wallet, ChevronRight, Plus, Minus, Banknote } from 'lucide-react';

export default function HomeView() {
  const { state, dispatch, report } = useStore();
  const { wallet, transactions, exchangeRate } = state;
  const [action, setAction] = useState<null | 'receive' | 'save' | 'withdraw'>(null);
  const [amount, setAmount] = useState('');
  const [feedback, setFeedback] = useState('');

  const savingsKobo = microUsdcToKobo(wallet.usdcSavingsMicro, exchangeRate);
  const totalKobo = wallet.nairaBalanceKobo + savingsKobo;

  const doAction = () => {
    const naira = parseFloat(amount);
    if (!naira || naira < 100) { setFeedback('Enter at least ₦100'); return; }
    const kobo = Math.round(naira * 100);

    if (action === 'receive') {
      dispatch({ type: 'RECEIVE_PAYMENT', amountKobo: kobo });
      setFeedback(`${formatNaira(kobo)} received`);
    } else if (action === 'save') {
      if (kobo > wallet.nairaBalanceKobo) { setFeedback('Not enough naira balance'); return; }
      dispatch({ type: 'SAVE_TO_VAULT', amountKobo: kobo });
      setFeedback(`${formatNaira(kobo)} saved to vault`);
    } else if (action === 'withdraw') {
      dispatch({ type: 'WITHDRAW_FROM_VAULT', amountKobo: kobo });
      setFeedback(`${formatNaira(kobo)} withdrawn`);
    }
    setAmount('');
    setTimeout(() => { setFeedback(''); setAction(null); }, 2000);
  };

  const recentTxs = transactions.slice(0, 6);

  return (
    <div className="px-5 pt-5">
      {/* Main Balance */}
      <div className="bg-gradient-to-br from-emerald-600 to-emerald-800 rounded-2xl p-5 text-white">
        <p className="text-emerald-200 text-xs font-medium">Total Balance</p>
        <p className="text-[2rem] font-bold mt-0.5 tracking-tight">{formatNaira(totalKobo)}</p>
        <div className="flex gap-6 mt-4 text-sm">
          <div>
            <p className="text-emerald-300 text-[11px]">Available</p>
            <p className="font-semibold">{formatNaira(wallet.nairaBalanceKobo)}</p>
          </div>
          <div>
            <p className="text-emerald-300 text-[11px]">In USDC Vault</p>
            <p className="font-semibold">{formatUsdc(wallet.usdcSavingsMicro)}</p>
          </div>
          <div>
            <p className="text-emerald-300 text-[11px]">Interest</p>
            <p className="font-semibold text-amber-300">{formatNaira(wallet.totalInterestKobo)}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 mt-3 text-emerald-300 text-[11px]">
          <TrendingUp className="w-3 h-3" />
          <span>₦1 = ${(1 / exchangeRate).toFixed(6)} · Rate: ₦{exchangeRate.toLocaleString()}/USD</span>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-3 gap-3 mt-5">
        <button
          onClick={() => { setAction(action === 'receive' ? null : 'receive'); setFeedback(''); }}
          className={`flex flex-col items-center gap-1.5 py-4 rounded-xl border transition-all ${
            action === 'receive' ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 bg-white'
          }`}
        >
          <div className={`w-9 h-9 rounded-full flex items-center justify-center ${
            action === 'receive' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'
          }`}>
            <ArrowDownLeft className="w-4 h-4" />
          </div>
          <span className="text-xs font-medium text-slate-700">Receive</span>
        </button>

        <button
          onClick={() => { setAction(action === 'save' ? null : 'save'); setFeedback(''); }}
          className={`flex flex-col items-center gap-1.5 py-4 rounded-xl border transition-all ${
            action === 'save' ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 bg-white'
          }`}
        >
          <div className={`w-9 h-9 rounded-full flex items-center justify-center ${
            action === 'save' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'
          }`}>
            <Vault className="w-4 h-4" />
          </div>
          <span className="text-xs font-medium text-slate-700">Save</span>
        </button>

        <button
          onClick={() => { setAction(action === 'withdraw' ? null : 'withdraw'); setFeedback(''); }}
          className={`flex flex-col items-center gap-1.5 py-4 rounded-xl border transition-all ${
            action === 'withdraw' ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 bg-white'
          }`}
        >
          <div className={`w-9 h-9 rounded-full flex items-center justify-center ${
            action === 'withdraw' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'
          }`}>
            <Banknote className="w-4 h-4" />
          </div>
          <span className="text-xs font-medium text-slate-700">Withdraw</span>
        </button>
      </div>

      {/* Action Panel */}
      {action && (
        <div className="mt-3 bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs text-slate-500 mb-2">
            {action === 'receive' && 'Simulate receiving a payment (Naira)'}
            {action === 'save' && 'Move naira to your USDC vault'}
            {action === 'withdraw' && 'Move USDC back to naira'}
          </p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-medium">₦</span>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                className="w-full pl-8 pr-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                autoFocus
              />
            </div>
            <button
              onClick={doAction}
              className="px-5 py-2.5 bg-emerald-600 text-white text-sm font-semibold rounded-xl hover:bg-emerald-700 transition active:scale-95"
            >
              Go
            </button>
          </div>
          <div className="flex gap-1.5 mt-2">
            {[5000, 20000, 50000, 100000, 500000].map((v) => (
              <button
                key={v}
                onClick={() => setAmount(v.toString())}
                className="text-[11px] px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg transition"
              >
                {formatCompact(v * 100)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Feedback */}
      {feedback && (
        <div className={`mt-3 px-4 py-2.5 rounded-xl text-sm font-medium ${
          feedback.includes('Not enough') || feedback.includes('Enter')
            ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'
        }`}>
          {feedback}
        </div>
      )}

      {/* Pidgin Summary */}
      {report.receivedKobo > 0 && (
        <div className="mt-5 bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <p className="text-[11px] font-semibold text-amber-700 uppercase tracking-wider mb-1">Today&apos;s Summary</p>
          <p className="text-sm text-amber-900 leading-relaxed italic">&ldquo;{report.pidginSummary}&rdquo;</p>
        </div>
      )}

      {/* Recent Transactions */}
      <div className="mt-6 mb-4">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Recent Activity</h3>
        {recentTxs.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-100 p-8 text-center">
            <Wallet className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-400">No transactions yet</p>
            <p className="text-xs text-slate-300 mt-1">Receive a payment to get started</p>
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
                  <p className="text-[11px] text-slate-400">{timeAgo(tx.createdAt)}</p>
                </div>
                <span className={`text-sm font-semibold tabular-nums ${
                  tx.direction === 'credit' ? 'text-emerald-600' : 'text-slate-700'
                }`}>
                  {tx.direction === 'credit' ? '+' : '-'}{formatNaira(tx.amountKobo)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
