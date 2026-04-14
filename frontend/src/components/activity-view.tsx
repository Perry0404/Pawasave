'use client';

import { useStore } from '@/lib/store';
import { formatNaira, formatUsdc, timeAgo, formatNairaDecimal } from '@/lib/format';
import { ArrowDownCircle, ArrowUpCircle, Repeat, DollarSign, Users, BarChart3, MessageCircle, TrendingUp, TrendingDown } from 'lucide-react';
import type { Transaction } from '@/lib/types';

const iconFor = (tx: Transaction) => {
  const base = 'w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0';
  switch (tx.type) {
    case 'deposit': return <div className={`${base} bg-emerald-100`}><ArrowDownCircle className="w-4 h-4 text-emerald-600" /></div>;
    case 'save_to_vault': return <div className={`${base} bg-blue-100`}><DollarSign className="w-4 h-4 text-blue-600" /></div>;
    case 'vault_withdraw': return <div className={`${base} bg-orange-100`}><ArrowUpCircle className="w-4 h-4 text-orange-500" /></div>;
    case 'split_auto_save': return <div className={`${base} bg-indigo-100`}><Repeat className="w-4 h-4 text-indigo-600" /></div>;
    case 'esusu_contribute': return <div className={`${base} bg-purple-100`}><Users className="w-4 h-4 text-purple-600" /></div>;
    case 'esusu_payout': return <div className={`${base} bg-amber-100`}><Users className="w-4 h-4 text-amber-600" /></div>;
    case 'interest': return <div className={`${base} bg-amber-100`}><TrendingUp className="w-4 h-4 text-amber-500" /></div>;
    case 'liquidity_bonus': return <div className={`${base} bg-emerald-100`}><TrendingUp className="w-4 h-4 text-emerald-500" /></div>;
    case 'emergency_payout': return <div className={`${base} bg-red-100`}><ArrowUpCircle className="w-4 h-4 text-red-500" /></div>;
    default: return <div className={`${base} bg-slate-100`}><Repeat className="w-4 h-4 text-slate-500" /></div>;
  }
};

const labelFor = (tx: Transaction) => {
  switch (tx.type) {
    case 'deposit': return 'Payment received';
    case 'save_to_vault': return 'Saved to vault';
    case 'vault_withdraw': return 'Withdrew from vault';
    case 'split_auto_save': return 'Auto-split to vault';
    case 'esusu_contribute': return 'Circle contribution';
    case 'esusu_payout': return 'Circle payout';
    case 'interest': return 'Interest earned';
    case 'liquidity_bonus': return 'Liquidity bonus';
    case 'emergency_payout': return 'Emergency payout';
    default: return tx.type;
  }
};

function DailySummary() {
  const { state } = useStore();
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayTxs = state.transactions.filter(t => t.createdAt >= dayStart);
  const income = todayTxs.filter(t => t.direction === 'credit' && t.type === 'deposit').reduce((s, t) => s + t.amountKobo, 0);
  const saved = todayTxs.filter(t => t.type === 'save_to_vault' || t.type === 'split_auto_save').reduce((s, t) => s + t.amountKobo, 0);
  const txCount = todayTxs.length;

  if (txCount === 0) return null;

  // Build pidgin summary
  const parts: string[] = [];
  if (income > 0) parts.push(`Money wey enter today na ${formatNairaDecimal(income)}`);
  if (saved > 0) parts.push(`you don save ${formatNairaDecimal(saved)} for vault`);
  if (txCount > 0) parts.push(`${txCount} movement${txCount > 1 ? 's' : ''} today`);

  return (
    <div className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-100 rounded-2xl p-4 mb-4">
      <div className="flex items-center gap-2 mb-2">
        <MessageCircle className="w-4 h-4 text-amber-600" />
        <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider">Today&#39;s Report</p>
      </div>
      <p className="text-sm text-amber-900 leading-relaxed">{parts.join('. ')}.</p>
      <div className="flex gap-4 mt-3 pt-3 border-t border-amber-100 text-xs">
        <div>
          <p className="text-amber-500">Income</p>
          <p className="font-semibold text-amber-800">{formatNaira(income)}</p>
        </div>
        <div>
          <p className="text-amber-500">Saved</p>
          <p className="font-semibold text-amber-800">{formatNaira(saved)}</p>
        </div>
        <div>
          <p className="text-amber-500">Movements</p>
          <p className="font-semibold text-amber-800">{txCount}</p>
        </div>
      </div>
    </div>
  );
}

function WeeklyTrend() {
  const { state } = useStore();
  const now = Date.now();
  const dayMs = 86400000;
  const days: { label: string; income: number }[] = [];

  for (let i = 6; i >= 0; i--) {
    const start = now - (i + 1) * dayMs;
    const end = now - i * dayMs;
    const dayTxs = state.transactions.filter(t => t.createdAt >= start && t.createdAt < end && t.type === 'deposit');
    const total = dayTxs.reduce((s, t) => s + t.amountKobo, 0);
    const d = new Date(end);
    days.push({ label: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()], income: total });
  }

  const max = Math.max(...days.map(d => d.income), 1);
  const totWeek = days.reduce((s, d) => s + d.income, 0);
  const totPrev = state.transactions
    .filter(t => t.createdAt >= now - 14 * dayMs && t.createdAt < now - 7 * dayMs && t.type === 'deposit')
    .reduce((s, t) => s + t.amountKobo, 0);
  const trend = totPrev > 0 ? ((totWeek - totPrev) / totPrev * 100) : 0;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-slate-400" />
          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider">7-Day Income</p>
        </div>
        {trend !== 0 && (
          <div className={`flex items-center gap-0.5 text-xs font-medium ${trend > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
            {trend > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {Math.abs(trend).toFixed(0)}%
          </div>
        )}
      </div>
      <div className="flex items-end gap-1.5 h-20">
        {days.map((d, i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-1">
            <div className="w-full rounded-t bg-emerald-200 transition-all" style={{ height: `${Math.max(4, (d.income / max) * 64)}px` }}>
              {d.income > 0 && <div className="w-full h-full bg-emerald-500 rounded-t opacity-70 hover:opacity-100 transition" />}
            </div>
            <span className="text-[10px] text-slate-400">{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ActivityView() {
  const { state } = useStore();
  const sorted = [...state.transactions].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="px-5 pt-5">
      <h2 className="text-lg font-bold text-slate-900 mb-4">Activity</h2>

      <DailySummary />
      <WeeklyTrend />

      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">All Transactions</p>

      {sorted.length === 0 ? (
        <div className="text-center py-12">
          <BarChart3 className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 text-sm font-medium">No activity yet</p>
          <p className="text-slate-400 text-xs mt-1">Receive a payment to get started</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((tx) => (
            <div key={tx.id} className="flex items-center gap-3 bg-white border border-slate-100 rounded-xl px-3.5 py-3">
              {iconFor(tx)}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-900 font-medium truncate">{labelFor(tx)}</p>
                <p className="text-xs text-slate-400">{timeAgo(tx.createdAt)}{tx.description ? ` \u00B7 ${tx.description}` : ''}</p>
              </div>
              <p className={`text-sm font-semibold tabular-nums ${tx.direction === 'credit' ? 'text-emerald-600' : 'text-slate-700'}`}>
                {tx.direction === 'credit' ? '+' : '-'}{formatNaira(tx.amountKobo)}
              </p>
            </div>
          ))}
        </div>
      )}
      <div className="h-6" />
    </div>
  );
}
