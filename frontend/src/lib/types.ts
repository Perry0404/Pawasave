export interface User {
  id: string;
  phone: string;
  businessName: string;
  createdAt: number;
}

export interface WalletState {
  nairaBalanceKobo: number;
  usdcSavingsMicro: number;
  totalInterestKobo: number;
}

export interface Transaction {
  id: string;
  type:
    | 'deposit'
    | 'save_to_vault'
    | 'vault_withdraw'
    | 'interest'
    | 'liquidity_bonus'
    | 'esusu_contribute'
    | 'esusu_payout'
    | 'emergency_payout'
    | 'split_auto_save';
  direction: 'credit' | 'debit';
  amountKobo: number;
  amountUsdc?: number;
  description: string;
  createdAt: number;
}

export interface SplitRule {
  id: string;
  name: string;
  vaultPercent: number;
  nairaPercent: number;
  esusuGroupId?: string;
  esusuPercent: number;
  minAmountKobo: number;
  active: boolean;
}

export interface EsusuMember {
  userId: string;
  name: string;
  payoutPosition: number;
  joinedAt: number;
}

export interface EsusuContribution {
  memberId: string;
  cycleNumber: number;
  amountKobo: number;
  paidAt: number;
}

export interface EmergencyRequest {
  id: string;
  requesterId: string;
  reason: string;
  amountKobo: number;
  votesFor: string[];
  votesAgainst: string[];
  status: 'voting' | 'approved' | 'rejected' | 'disbursed';
  createdAt: number;
}

export interface EsusuGroup {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  contributionAmountKobo: number;
  cyclePeriod: 'daily' | 'weekly' | 'biweekly' | 'monthly';
  maxMembers: number;
  currentCycle: number;
  members: EsusuMember[];
  contributions: EsusuContribution[];
  payoutOrder: string[];
  nextPayoutIndex: number;
  potBalanceKobo: number;
  emergencyPotKobo: number;
  emergencyPotBps: number;
  savingsMode: 'usdc' | 'naira';
  status: 'forming' | 'active' | 'completed';
  emergencyRequests: EmergencyRequest[];
  createdAt: number;
}

export interface DailyReport {
  receivedKobo: number;
  savedKobo: number;
  interestKobo: number;
  esusuContributedKobo: number;
  groupPotTotalKobo: number;
  pidginSummary: string;
}

export interface AppState {
  user: User | null;
  wallet: WalletState;
  transactions: Transaction[];
  splitRules: SplitRule[];
  esusuGroups: EsusuGroup[];
  exchangeRate: number;
  lastInterestAccrual: number;
}
