'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';
import { formatNaira, timeAgo } from '@/lib/format';
import { Users, Plus, HandCoins, AlertTriangle, ChevronDown, ChevronUp, CheckCircle, XCircle } from 'lucide-react';
import type { EsusuGroup, EmergencyRequest } from '@/lib/types';

function CreateGroupForm({ onClose }: { onClose: () => void }) {
  const { dispatch } = useStore();
  const [name, setName] = useState('');
  const [contKobo, setContKobo] = useState('5000');
  const [cyclePeriod, setCyclePeriod] = useState<'daily' | 'weekly' | 'biweekly' | 'monthly'>('monthly');
  const [members, setMembers] = useState('5');

  const submit = () => {
    if (!name.trim()) return;
    dispatch({
      type: 'CREATE_ESUSU_GROUP',
      name: name.trim(),
      description: '',
      contributionKobo: Math.round(parseFloat(contKobo) * 100),
      cyclePeriod,
      maxMembers: parseInt(members) || 5,
      savingsMode: 'naira',
    });
    onClose();
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5 mt-4">
      <p className="font-semibold text-slate-900 text-sm mb-3">Start New Circle</p>
      <div className="space-y-3">
        <div>
          <label className="text-xs text-slate-500">Circle name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Market Women Savings"
            className="w-full mt-1 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-xs text-slate-500">Contribution (₦)</label>
            <input type="number" value={contKobo} onChange={(e) => setContKobo(e.target.value)}
              className="w-full mt-1 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
          <div>
            <label className="text-xs text-slate-500">Cycle</label>
            <select value={cyclePeriod} onChange={(e) => setCyclePeriod(e.target.value as any)}
              className="w-full mt-1 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500">
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-500">Members</label>
            <input type="number" value={members} onChange={(e) => setMembers(e.target.value)}
              className="w-full mt-1 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 bg-slate-100 text-slate-600 text-sm font-medium rounded-lg">Cancel</button>
          <button onClick={submit} className="flex-1 py-2.5 bg-emerald-600 text-white text-sm font-semibold rounded-lg">Create</button>
        </div>
      </div>
    </div>
  );
}

function EmergencySection({ group }: { group: EsusuGroup }) {
  const { state, dispatch } = useStore();
  const [showForm, setShowForm] = useState(false);
  const [reason, setReason] = useState('');
  const [amtStr, setAmtStr] = useState('');

  const currentMember = group.members.find(m => m.userId === state.user?.id);
  const pendingRequests = group.emergencyRequests.filter(r => r.status === 'voting');

  const submitRequest = () => {
    if (!reason.trim() || !amtStr) return;
    dispatch({
      type: 'REQUEST_EMERGENCY',
      groupId: group.id,
      amountKobo: Math.round(parseFloat(amtStr) * 100),
      reason: reason.trim(),
    });
    setShowForm(false);
    setReason('');
    setAmtStr('');
  };

  const vote = (requestId: string, approve: boolean) => {
    dispatch({ type: 'VOTE_EMERGENCY', groupId: group.id, requestId, approve });
  };

  return (
    <div className="mt-3">
      {currentMember && !showForm && (
        <button onClick={() => setShowForm(true)} className="flex items-center gap-1.5 text-xs text-amber-600 font-medium">
          <AlertTriangle className="w-3 h-3" /> Request emergency withdrawal
        </button>
      )}
      {showForm && (
        <div className="bg-amber-50 rounded-xl p-3 mt-2 space-y-2">
          <input value={amtStr} onChange={(e) => setAmtStr(e.target.value)} type="number" placeholder="Amount (₦)"
            className="w-full px-3 py-2 bg-white border border-amber-200 rounded-lg text-sm focus:outline-none" />
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for emergency"
            className="w-full px-3 py-2 bg-white border border-amber-200 rounded-lg text-sm focus:outline-none" />
          <div className="flex gap-2">
            <button onClick={() => setShowForm(false)} className="flex-1 py-2 text-xs text-slate-500 bg-white border border-slate-200 rounded-lg">Cancel</button>
            <button onClick={submitRequest} className="flex-1 py-2 text-xs text-white bg-amber-500 font-medium rounded-lg">Submit</button>
          </div>
        </div>
      )}
      {pendingRequests.map((req: EmergencyRequest) => (
        <div key={req.id} className="bg-amber-50 border border-amber-100 rounded-xl p-3 mt-2">
          <p className="text-xs text-amber-800 font-medium">Emergency: {formatNaira(req.amountKobo)}</p>
          <p className="text-xs text-amber-600 mt-0.5">{req.reason}</p>
          <p className="text-xs text-slate-400 mt-1">{req.votesFor.length + req.votesAgainst.length}/{group.members.length} votes &#183; needs majority</p>
          {req.requesterId !== state.user?.id && !req.votesFor.includes(state.user?.id ?? '') && !req.votesAgainst.includes(state.user?.id ?? '') && (
            <div className="flex gap-2 mt-2">
              <button onClick={() => vote(req.id, true)} className="flex items-center gap-1 text-xs px-3 py-1.5 text-emerald-700 bg-emerald-100 rounded-lg font-medium">
                <CheckCircle className="w-3 h-3" /> Approve
              </button>
              <button onClick={() => vote(req.id, false)} className="flex items-center gap-1 text-xs px-3 py-1.5 text-red-700 bg-red-100 rounded-lg font-medium">
                <XCircle className="w-3 h-3" /> Reject
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function GroupCard({ group }: { group: EsusuGroup }) {
  const { state, dispatch } = useStore();
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState('');
  const currentMember = group.members.find(m => m.userId === state.user?.id);

  const contribute = () => {
    if (state.wallet.nairaBalanceKobo < group.contributionAmountKobo) {
      setFeedback('Insufficient balance');
      setTimeout(() => setFeedback(''), 2000);
      return;
    }
    dispatch({ type: 'CONTRIBUTE_ESUSU', groupId: group.id });
    setFeedback('Contribution made!');
    setTimeout(() => setFeedback(''), 2000);
  };

  const potKobo = group.potBalanceKobo;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center justify-between p-4">
        <div className="flex items-center gap-3 text-left">
          <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center">
            <Users className="w-5 h-5 text-purple-600" />
          </div>
          <div>
            <p className="font-semibold text-slate-900 text-sm">{group.name}</p>
            <p className="text-xs text-slate-400">{group.members.length}/{group.maxMembers} members &#183; {group.cyclePeriod}</p>
          </div>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>
      {expanded && (
        <div className="px-4 pb-4 border-t border-slate-100 pt-3">
          <div className="grid grid-cols-3 gap-2 text-center mb-3">
            <div className="bg-slate-50 rounded-lg py-2">
              <p className="text-xs text-slate-400">Contribution</p>
              <p className="text-sm font-semibold text-slate-900">{formatNaira(group.contributionAmountKobo)}</p>
            </div>
            <div className="bg-slate-50 rounded-lg py-2">
              <p className="text-xs text-slate-400">Pot Total</p>
              <p className="text-sm font-semibold text-slate-900">{formatNaira(potKobo)}</p>
            </div>
            <div className="bg-slate-50 rounded-lg py-2">
              <p className="text-xs text-slate-400">Round</p>
              <p className="text-sm font-semibold text-slate-900">{group.currentCycle}/{group.members.length}</p>
            </div>
          </div>

          {/* Members */}
          <p className="text-xs text-slate-500 mb-1.5 font-medium">Members</p>
          <div className="space-y-1 mb-3">
            {group.members.map((m, i) => (
              <div key={m.userId} className="flex items-center justify-between text-xs">
                <span className="text-slate-600">
                  {m.userId === state.user?.id ? 'You' : `Member ${i + 1}`}
                  {i === (group.currentCycle > 0 ? (group.currentCycle - 1) % group.members.length : 0) && (
                    <span className="ml-1.5 text-emerald-600 font-medium">(receives this round)</span>
                  )}
                </span>
                <span className="text-slate-400">{group.contributions.filter(c => c.memberId === m.userId).length} contributions</span>
              </div>
            ))}
          </div>

          {currentMember && (
            <button onClick={contribute}
              className="w-full py-2.5 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold rounded-xl transition active:scale-[0.98] flex items-center justify-center gap-1.5">
              <HandCoins className="w-4 h-4" /> Contribute {formatNaira(group.contributionAmountKobo)}
            </button>
          )}

          {feedback && (
            <p className={`mt-2 text-xs font-medium ${feedback.includes('Insufficient') ? 'text-red-600' : 'text-emerald-600'}`}>{feedback}</p>
          )}

          <EmergencySection group={group} />
        </div>
      )}
    </div>
  );
}

export default function GroupsView() {
  const { state } = useStore();
  const [creating, setCreating] = useState(false);

  return (
    <div className="px-5 pt-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Esusu Circles</h2>
          <p className="text-xs text-slate-400">Ajo contribution groups</p>
        </div>
        <button onClick={() => setCreating(!creating)}
          className="w-9 h-9 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl flex items-center justify-center transition">
          <Plus className="w-5 h-5" />
        </button>
      </div>

      {creating && <CreateGroupForm onClose={() => setCreating(false)} />}

      <div className="space-y-3 mt-3">
        {state.esusuGroups.length === 0 ? (
          <div className="text-center py-12">
            <Users className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500 text-sm font-medium">No circles yet</p>
            <p className="text-slate-400 text-xs mt-1">Start one and invite your people</p>
          </div>
        ) : (
          state.esusuGroups.map(g => <GroupCard key={g.id} group={g} />)
        )}
      </div>
    </div>
  );
}
