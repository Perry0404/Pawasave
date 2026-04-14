'use client';

import React, { createContext, useContext, useReducer, useEffect, useCallback } from 'react';
import type { AppState, Transaction, SplitRule, EsusuGroup, User, DailyReport } from './types';

const STORAGE_KEY = 'pawasave_state';
const RATE_BASE = 1550;

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function initialState(): AppState {
  return {
    user: null,
    wallet: { nairaBalanceKobo: 0, usdcSavingsMicro: 0, totalInterestKobo: 0 },
    transactions: [],
    splitRules: [],
    esusuGroups: [],
    exchangeRate: RATE_BASE + Math.round((Math.random() - 0.5) * 60),
    lastInterestAccrual: Date.now(),
  };
}

function loadState(): AppState {
  if (typeof window === 'undefined') return initialState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return initialState();
}

function persist(state: AppState) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

function koboToMicroUsdc(kobo: number, rate: number): number {
  return Math.floor((kobo / 100 / rate) * 1_000_000);
}

function microUsdcToKobo(micro: number, rate: number): number {
  return Math.floor((micro / 1_000_000) * rate * 100);
}

// ── Actions ──

type Action =
  | { type: 'REGISTER'; phone: string; businessName: string; password: string }
  | { type: 'LOGIN'; phone: string }
  | { type: 'LOGOUT' }
  | { type: 'RECEIVE_PAYMENT'; amountKobo: number }
  | { type: 'SAVE_TO_VAULT'; amountKobo: number }
  | { type: 'WITHDRAW_FROM_VAULT'; amountKobo: number }
  | { type: 'ADD_SPLIT_RULE'; rule: Omit<SplitRule, 'id'> }
  | { type: 'TOGGLE_SPLIT_RULE'; id: string }
  | { type: 'DELETE_SPLIT_RULE'; id: string }
  | { type: 'CREATE_ESUSU_GROUP'; name: string; description: string; contributionKobo: number; cyclePeriod: EsusuGroup['cyclePeriod']; maxMembers: number; savingsMode: EsusuGroup['savingsMode'] }
  | { type: 'CONTRIBUTE_ESUSU'; groupId: string }
  | { type: 'REQUEST_EMERGENCY'; groupId: string; reason: string; amountKobo: number }
  | { type: 'VOTE_EMERGENCY'; groupId: string; requestId: string; approve: boolean }
  | { type: 'ACCRUE_INTEREST' };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'REGISTER': {
      const user: User = {
        id: uid(),
        phone: action.phone,
        businessName: action.businessName,
        createdAt: Date.now(),
      };
      return { ...state, user };
    }

    case 'LOGIN': {
      if (state.user && state.user.phone === action.phone) return state;
      return state;
    }

    case 'LOGOUT': {
      return initialState();
    }

    case 'RECEIVE_PAYMENT': {
      const { amountKobo } = action;
      let nairaForBalance = amountKobo;
      let vaultSaveKobo = 0;
      let esusuSaveKobo = 0;
      const newTxs: Transaction[] = [];

      // Execute active split rules
      const activeRule = state.splitRules.find(
        (r) => r.active && amountKobo >= r.minAmountKobo
      );
      if (activeRule) {
        vaultSaveKobo = Math.floor(amountKobo * activeRule.vaultPercent / 100);
        esusuSaveKobo = Math.floor(amountKobo * activeRule.esusuPercent / 100);
        nairaForBalance = amountKobo - vaultSaveKobo - esusuSaveKobo;

        if (vaultSaveKobo > 0) {
          newTxs.push({
            id: uid(), type: 'split_auto_save', direction: 'debit',
            amountKobo: vaultSaveKobo,
            amountUsdc: koboToMicroUsdc(vaultSaveKobo, state.exchangeRate),
            description: `Auto-save ${activeRule.vaultPercent}% to vault`,
            createdAt: Date.now(),
          });
        }
      }

      const depositTx: Transaction = {
        id: uid(), type: 'deposit', direction: 'credit',
        amountKobo,
        description: 'Payment received',
        createdAt: Date.now(),
      };

      // Check 5-min liquidity bonus (simulate: 10% chance of delay)
      const delayed = Math.random() < 0.1;
      const bonusKobo = delayed ? Math.floor(amountKobo * 50 / 10000) : 0;
      if (bonusKobo > 0) {
        newTxs.push({
          id: uid(), type: 'liquidity_bonus', direction: 'credit',
          amountKobo: bonusKobo,
          description: '5-min guarantee bonus',
          createdAt: Date.now(),
        });
      }

      const usdcAdd = koboToMicroUsdc(vaultSaveKobo, state.exchangeRate);

      // Handle esusu split
      let updatedGroups = state.esusuGroups;
      if (esusuSaveKobo > 0 && activeRule?.esusuGroupId) {
        updatedGroups = state.esusuGroups.map((g) => {
          if (g.id === activeRule.esusuGroupId) {
            const emergencyPortion = Math.floor(esusuSaveKobo * g.emergencyPotBps / 10000);
            return {
              ...g,
              potBalanceKobo: g.potBalanceKobo + esusuSaveKobo - emergencyPortion,
              emergencyPotKobo: g.emergencyPotKobo + emergencyPortion,
            };
          }
          return g;
        });
      }

      return {
        ...state,
        wallet: {
          nairaBalanceKobo: state.wallet.nairaBalanceKobo + nairaForBalance + bonusKobo,
          usdcSavingsMicro: state.wallet.usdcSavingsMicro + usdcAdd,
          totalInterestKobo: state.wallet.totalInterestKobo + bonusKobo,
        },
        transactions: [depositTx, ...newTxs, ...state.transactions],
        esusuGroups: updatedGroups,
      };
    }

    case 'SAVE_TO_VAULT': {
      const { amountKobo } = action;
      if (amountKobo > state.wallet.nairaBalanceKobo) return state;
      const usdc = koboToMicroUsdc(amountKobo, state.exchangeRate);
      const tx: Transaction = {
        id: uid(), type: 'save_to_vault', direction: 'debit',
        amountKobo, amountUsdc: usdc,
        description: 'Saved to USDC vault',
        createdAt: Date.now(),
      };
      return {
        ...state,
        wallet: {
          ...state.wallet,
          nairaBalanceKobo: state.wallet.nairaBalanceKobo - amountKobo,
          usdcSavingsMicro: state.wallet.usdcSavingsMicro + usdc,
        },
        transactions: [tx, ...state.transactions],
      };
    }

    case 'WITHDRAW_FROM_VAULT': {
      const { amountKobo } = action;
      const usdc = koboToMicroUsdc(amountKobo, state.exchangeRate);
      if (usdc > state.wallet.usdcSavingsMicro) return state;
      const tx: Transaction = {
        id: uid(), type: 'vault_withdraw', direction: 'credit',
        amountKobo, amountUsdc: usdc,
        description: 'Withdrew from USDC vault',
        createdAt: Date.now(),
      };
      return {
        ...state,
        wallet: {
          ...state.wallet,
          nairaBalanceKobo: state.wallet.nairaBalanceKobo + amountKobo,
          usdcSavingsMicro: state.wallet.usdcSavingsMicro - usdc,
        },
        transactions: [tx, ...state.transactions],
      };
    }

    case 'ADD_SPLIT_RULE': {
      return {
        ...state,
        splitRules: [...state.splitRules, { ...action.rule, id: uid() }],
      };
    }

    case 'TOGGLE_SPLIT_RULE': {
      return {
        ...state,
        splitRules: state.splitRules.map((r) =>
          r.id === action.id ? { ...r, active: !r.active } : r
        ),
      };
    }

    case 'DELETE_SPLIT_RULE': {
      return {
        ...state,
        splitRules: state.splitRules.filter((r) => r.id !== action.id),
      };
    }

    case 'CREATE_ESUSU_GROUP': {
      if (!state.user) return state;
      const group: EsusuGroup = {
        id: uid(),
        name: action.name,
        description: action.description,
        ownerId: state.user.id,
        contributionAmountKobo: action.contributionKobo,
        cyclePeriod: action.cyclePeriod,
        maxMembers: action.maxMembers,
        currentCycle: 0,
        members: [{
          userId: state.user.id,
          name: state.user.businessName || state.user.phone,
          payoutPosition: 0,
          joinedAt: Date.now(),
        }],
        contributions: [],
        payoutOrder: [state.user.id],
        nextPayoutIndex: 0,
        potBalanceKobo: 0,
        emergencyPotKobo: 0,
        emergencyPotBps: 500,
        savingsMode: action.savingsMode,
        status: 'forming',
        emergencyRequests: [],
        createdAt: Date.now(),
      };
      return { ...state, esusuGroups: [...state.esusuGroups, group] };
    }

    case 'CONTRIBUTE_ESUSU': {
      if (!state.user) return state;
      const gIdx = state.esusuGroups.findIndex((g) => g.id === action.groupId);
      if (gIdx === -1) return state;
      const group = state.esusuGroups[gIdx];
      if (group.contributionAmountKobo > state.wallet.nairaBalanceKobo) return state;

      const emergencyPortion = Math.floor(group.contributionAmountKobo * group.emergencyPotBps / 10000);
      const mainPortion = group.contributionAmountKobo - emergencyPortion;

      const newContribution = {
        memberId: state.user.id,
        cycleNumber: group.currentCycle,
        amountKobo: group.contributionAmountKobo,
        paidAt: Date.now(),
      };

      const updatedGroup = {
        ...group,
        potBalanceKobo: group.potBalanceKobo + mainPortion,
        emergencyPotKobo: group.emergencyPotKobo + emergencyPortion,
        contributions: [...group.contributions, newContribution],
        status: group.status === 'forming' ? 'active' as const : group.status,
        currentCycle: group.status === 'forming' ? 1 : group.currentCycle,
      };

      const tx: Transaction = {
        id: uid(), type: 'esusu_contribute', direction: 'debit',
        amountKobo: group.contributionAmountKobo,
        description: `Contribution to ${group.name}`,
        createdAt: Date.now(),
      };

      const newGroups = [...state.esusuGroups];
      newGroups[gIdx] = updatedGroup;

      return {
        ...state,
        wallet: {
          ...state.wallet,
          nairaBalanceKobo: state.wallet.nairaBalanceKobo - group.contributionAmountKobo,
        },
        esusuGroups: newGroups,
        transactions: [tx, ...state.transactions],
      };
    }

    case 'REQUEST_EMERGENCY': {
      if (!state.user) return state;
      const gIdx = state.esusuGroups.findIndex((g) => g.id === action.groupId);
      if (gIdx === -1) return state;
      const group = state.esusuGroups[gIdx];
      if (action.amountKobo > group.emergencyPotKobo) return state;

      const request = {
        id: uid(),
        requesterId: state.user.id,
        reason: action.reason,
        amountKobo: action.amountKobo,
        votesFor: [] as string[],
        votesAgainst: [] as string[],
        status: 'voting' as const,
        createdAt: Date.now(),
      };

      const newGroups = [...state.esusuGroups];
      newGroups[gIdx] = {
        ...group,
        emergencyRequests: [...group.emergencyRequests, request],
      };

      return { ...state, esusuGroups: newGroups };
    }

    case 'VOTE_EMERGENCY': {
      if (!state.user) return state;
      const gIdx = state.esusuGroups.findIndex((g) => g.id === action.groupId);
      if (gIdx === -1) return state;
      const group = state.esusuGroups[gIdx];
      const rIdx = group.emergencyRequests.findIndex((r) => r.id === action.requestId);
      if (rIdx === -1) return state;

      const req = { ...group.emergencyRequests[rIdx] };
      if (action.approve) {
        req.votesFor = [...req.votesFor, state.user.id];
      } else {
        req.votesAgainst = [...req.votesAgainst, state.user.id];
      }

      // Auto-approve if majority
      const memberCount = group.members.length;
      const majority = Math.ceil(memberCount / 2);
      let walletUpdate = state.wallet;
      let extraTx: Transaction[] = [];

      if (req.votesFor.length >= majority && req.status === 'voting') {
        req.status = 'disbursed';
        walletUpdate = {
          ...state.wallet,
          nairaBalanceKobo: state.wallet.nairaBalanceKobo + req.amountKobo,
        };
        extraTx = [{
          id: uid(), type: 'emergency_payout', direction: 'credit',
          amountKobo: req.amountKobo,
          description: `Emergency: ${req.reason}`,
          createdAt: Date.now(),
        }];
      }
      if (req.votesAgainst.length >= majority) {
        req.status = 'rejected';
      }

      const newRequests = [...group.emergencyRequests];
      newRequests[rIdx] = req;

      const updatedGroup = {
        ...group,
        emergencyRequests: newRequests,
        emergencyPotKobo: req.status === 'disbursed'
          ? group.emergencyPotKobo - req.amountKobo
          : group.emergencyPotKobo,
      };

      const newGroups = [...state.esusuGroups];
      newGroups[gIdx] = updatedGroup;

      return {
        ...state,
        wallet: walletUpdate,
        esusuGroups: newGroups,
        transactions: [...extraTx, ...state.transactions],
      };
    }

    case 'ACCRUE_INTEREST': {
      if (state.wallet.usdcSavingsMicro <= 0) return state;
      const hoursSince = (Date.now() - state.lastInterestAccrual) / (1000 * 60 * 60);
      if (hoursSince < 1) return state;

      const annualRate = 0.05;
      const hourlyRate = annualRate / 8760;
      const interestUsdc = Math.floor(state.wallet.usdcSavingsMicro * hourlyRate * hoursSince);
      if (interestUsdc <= 0) return state;

      const interestKobo = microUsdcToKobo(interestUsdc, state.exchangeRate);

      const tx: Transaction = {
        id: uid(), type: 'interest', direction: 'credit',
        amountKobo: interestKobo, amountUsdc: interestUsdc,
        description: 'Interest earned on USDC savings',
        createdAt: Date.now(),
      };

      return {
        ...state,
        wallet: {
          ...state.wallet,
          usdcSavingsMicro: state.wallet.usdcSavingsMicro + interestUsdc,
          totalInterestKobo: state.wallet.totalInterestKobo + interestKobo,
        },
        transactions: [tx, ...state.transactions],
        lastInterestAccrual: Date.now(),
      };
    }

    default:
      return state;
  }
}

// ── Daily Report ──

export function generateReport(state: AppState): DailyReport {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const ts = todayStart.getTime();

  const todayTxs = state.transactions.filter((t) => t.createdAt >= ts);

  let receivedKobo = 0, savedKobo = 0, interestKobo = 0, esusuContributedKobo = 0;
  for (const tx of todayTxs) {
    if (tx.type === 'deposit') receivedKobo += tx.amountKobo;
    if (tx.type === 'save_to_vault' || tx.type === 'split_auto_save') savedKobo += tx.amountKobo;
    if (tx.type === 'interest' || tx.type === 'liquidity_bonus') interestKobo += tx.amountKobo;
    if (tx.type === 'esusu_contribute') esusuContributedKobo += tx.amountKobo;
  }

  const groupPotTotalKobo = state.esusuGroups.reduce((a, g) => a + g.potBalanceKobo, 0);
  const pidginSummary = buildPidgin(receivedKobo, savedKobo, interestKobo, groupPotTotalKobo);

  return { receivedKobo, savedKobo, interestKobo, esusuContributedKobo, groupPotTotalKobo, pidginSummary };
}

function fmtN(kobo: number): string {
  const n = kobo / 100;
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `₦${(n / 1_000).toFixed(0)}k`;
  return `₦${n.toLocaleString()}`;
}

function buildPidgin(received: number, saved: number, interest: number, groupPot: number): string {
  const parts: string[] = [];
  if (received > 0) parts.push(`Today you collect ${fmtN(received)} for hand`);
  else parts.push('E be like say money never enter today o');
  if (saved > 0) parts.push(`${fmtN(saved)} don enter your USDC vault`);
  if (interest > 0) parts.push(`you earn ${fmtN(interest)} interest — e sweet`);
  if (groupPot > 0) parts.push(`your group pot don reach ${fmtN(groupPot)}`);
  parts.push('PawaSave dey hold your back!');
  return parts.join('. ') + '.';
}

// ── Context ──

interface StoreContext {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  report: DailyReport;
}

const Ctx = createContext<StoreContext | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadState);

  useEffect(() => { persist(state); }, [state]);

  // Accrue interest periodically
  useEffect(() => {
    if (!state.user) return;
    dispatch({ type: 'ACCRUE_INTEREST' });
    const iv = setInterval(() => dispatch({ type: 'ACCRUE_INTEREST' }), 60_000);
    return () => clearInterval(iv);
  }, [state.user]);

  const report = generateReport(state);

  return <Ctx.Provider value={{ state, dispatch, report }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}

export { koboToMicroUsdc, microUsdcToKobo };
