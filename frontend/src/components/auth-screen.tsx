'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';
import { Phone, Lock, Store, ArrowRight, Shield } from 'lucide-react';

export default function AuthScreen() {
  const { dispatch } = useStore();
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [biz, setBiz] = useState('');
  const [err, setErr] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');

    if (!/^0[7-9][01]\d{8}$/.test(phone)) {
      setErr('Enter a valid Nigerian phone number');
      return;
    }
    if (password.length < 6) {
      setErr('Password must be at least 6 characters');
      return;
    }

    if (mode === 'register') {
      dispatch({ type: 'REGISTER', phone, password, businessName: biz || phone });
    } else {
      dispatch({ type: 'LOGIN', phone });
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      {/* Top Section */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 pt-16 pb-8">
        <div className="w-14 h-14 rounded-2xl bg-emerald-600 flex items-center justify-center mb-5">
          <Shield className="w-7 h-7 text-white" strokeWidth={2.5} />
        </div>
        <h1 className="text-3xl font-bold text-white tracking-tight">PawaSave</h1>
        <p className="text-slate-400 mt-2 text-center text-sm leading-relaxed max-w-xs">
          Collect naira. Save in dollars.<br />Withdraw anytime — even in 5 minutes.
        </p>
      </div>

      {/* Form Card */}
      <div className="bg-white rounded-t-3xl px-6 pt-8 pb-10">
        {/* Tab Toggle */}
        <div className="flex bg-slate-100 rounded-xl p-1 mb-6">
          <button
            onClick={() => { setMode('register'); setErr(''); }}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${
              mode === 'register' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
            }`}
          >
            Create Account
          </button>
          <button
            onClick={() => { setMode('login'); setErr(''); }}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${
              mode === 'login' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
            }`}
          >
            Sign In
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          {/* Phone */}
          <div>
            <label className="text-xs font-medium text-slate-500 mb-1.5 block">Phone number</label>
            <div className="relative">
              <Phone className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="08012345678"
                className="w-full pl-11 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
                maxLength={11}
              />
            </div>
          </div>

          {/* Password */}
          <div>
            <label className="text-xs font-medium text-slate-500 mb-1.5 block">Password</label>
            <div className="relative">
              <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min 6 characters"
                className="w-full pl-11 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
              />
            </div>
          </div>

          {/* Business Name (register only) */}
          {mode === 'register' && (
            <div>
              <label className="text-xs font-medium text-slate-500 mb-1.5 block">Business name</label>
              <div className="relative">
                <Store className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  value={biz}
                  onChange={(e) => setBiz(e.target.value)}
                  placeholder="e.g. Mama Nkechi Store"
                  className="w-full pl-11 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
                />
              </div>
            </div>
          )}

          {err && (
            <p className="text-red-600 text-xs bg-red-50 px-3 py-2 rounded-lg">{err}</p>
          )}

          <button
            type="submit"
            className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors active:scale-[0.98]"
          >
            {mode === 'register' ? 'Get Started' : 'Sign In'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <p className="text-center text-xs text-slate-400 mt-6">
          Your savings are protected in USDC on Base L2
        </p>
      </div>
    </div>
  );
}
