'use client';

import { useState } from 'react';
import { useStore, microUsdcToKobo, koboToMicroUsdc } from '@/lib/store';
import { formatNaira, formatUsdc } from '@/lib/format';
import { Shield, ArrowDown, ArrowUp, Info } from 'lucide-react';

export default function SaveView() {
  const { state, dispatch } = useStore();
  const { wallet, exchangeRate } = state;
  const [mode, setMode] = useState<'save' | 'withdraw'>('save');
  const [amount, setAmount] = useState('');
  const [feedback, setFeedback] = useState('');

  const savingsKobo = microUsdcToKobo(wallet.usdcSavingsMicro, exchangeRate);

  const execute = () => {
    const naira = parseFloat(amount);
    if (!naira || naira < 100) { setFeedback('Minimum ₦100'); return; }
    const kobo = Math.round(naira * 100);

    if (mode === 'save') {
      if (kobo > wallet.nairaBalanceKobo) { setFeedback('Insufficient naira balance'); return; }
      dispatch({ type: 'SAVE_TO_VAULT', amountKobo: kobo });
      const usdc = koboToMicroUsdc(kobo, exchangeRate);
      setFeedback(`Saved ${formatUsdc(usdc)} to vault`);
    } else {
      const usdc = koboToMicroUsdc(kobo, exchangeRate);
      if (usdc > wallet.usdcSavingsMicro) { setFeedback('Insufficient vault balance'); return; }
      dispatch({ type: 'WITHDRAW_FROM_VAULT', amountKobo: kobo });
      setFeedback(`Withdrew ${formatNaira(kobo)} from vault`);
    }
    setAmount('');
    setTimeout(() => setFeedback(''), 3000);
  };

  return (
    <div className="px-5 pt-5">
      {/* Vault Card */}
      <div className="bg-gradient-to-br from-blue-600 to-indigo-700 rounded-2xl p-5 text-white">
        <div className="flex items-center gap-2 mb-3">
          <Shield className="w-4 h-4 text-blue-200" />
          <p className="text-blue-200 text-xs font-medium uppercase tracking-wider">USDC Vault &#183; Base L2</p>
        </div>
        <p className="text-3xl font-bold tracking-tight">{formatUsdc(wallet.usdcSavingsMicro)}</p>
        <p className="text-blue-300 text-sm mt-1">&#8776; {formatNaira(savingsKobo)}</p>
        <div className="flex items-center gap-4 mt-4 pt-3 border-t border-white/10 text-xs">
          <div>
            <p className="text-blue-300">Interest earned</p>
            <p className="font-semibold text-amber-300 mt-0.5">{formatNaira(wallet.totalInterestKobo)}</p>
          </div>
          <div>
            <p className="text-blue-300">APY</p>
            <p className="font-semibold mt-0.5">5.00%</p>
          </div>
          <div>
            <p className="text-blue-300">Rate</p>
            <p className="font-semibold mt-0.5">₦{exchangeRate}/USD</p>
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="flex items-start gap-2.5 mt-4 bg-slate-100 rounded-xl px-4 py-3">
        <Info className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-slate-500 leading-relaxed">
          Your savings convert to USDC at current rates. Interest accrues every hour at 5% APY. Withdraw to naira anytime &#8212; no lock period.
        </p>
      </div>

      {/* Save / Withdraw Toggle */}
      <div className="flex bg-slate-100 rounded-xl p-1 mt-5 mb-4">
        <button
          onClick={() => { setMode('save'); setFeedback(''); }}
          className={`flex-1 py-2.5 text-sm font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-all ${
            mode === 'save' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          <ArrowDown className="w-3.5 h-3.5" /> Save
        </button>
        <button
          onClick={() => { setMode('withdraw'); setFeedback(''); }}
          className={`flex-1 py-2.5 text-sm font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-all ${
            mode === 'withdraw' ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-500'
          }`}
        >
          <ArrowUp className="w-3.5 h-3.5" /> Withdraw
        </button>
      </div>

      {/* Amount Input */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <p className="text-xs text-slate-500 mb-1">
          {mode === 'save' ? 'Amount to save (Naira)' : 'Amount to withdraw (Naira)'}
        </p>
        <p className="text-xs text-slate-400 mb-3">
          {mode === 'save'
            ? `Available: ${formatNaira(wallet.nairaBalanceKobo)}`
            : `In vault: ${formatUsdc(wallet.usdcSavingsMicro)} (${formatNaira(savingsKobo)})`
          }
        </p>
        <div className="relative mb-3">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-lg font-medium">₦</span>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="w-full pl-10 pr-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
        </div>
        {amount && parseFloat(amount) > 0 && (
          <p className="text-xs text-slate-400 mb-3">
            &#8776; {formatUsdc(koboToMicroUsdc(Math.round(parseFloat(amount) * 100), exchangeRate))} USDC
          </p>
        )}
        <div className="flex gap-2 mb-4">
          {[10000, 50000, 100000, 500000].map((v) => (
            <button
              key={v}
              onClick={() => setAmount(v.toString())}
              className="flex-1 text-xs py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg transition font-medium"
            >
              {v >= 1000 ? `${v / 1000}k` : v}
            </button>
          ))}
        </div>
        <button
          onClick={execute}
          className={`w-full py-3.5 text-white font-semibold rounded-xl transition active:scale-[0.98] ${
            mode === 'save'
              ? 'bg-emerald-600 hover:bg-emerald-700'
              : 'bg-orange-500 hover:bg-orange-600'
          }`}
        >
          {mode === 'save' ? 'Save to Vault' : 'Withdraw to Naira'}
        </button>
      </div>

      {feedback && (
        <div className={`mt-3 px-4 py-2.5 rounded-xl text-sm font-medium ${
          feedback.includes('Insufficient') || feedback.includes('Minimum')
            ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'
        }`}>
          {feedback}
        </div>
      )}
    </div>
  );
}
