export interface Profile {
  id: string
  phone: string | null
  display_name: string
  kyc_status: 'pending' | 'submitted' | 'verified' | 'rejected'
  kyc_type: 'bvn' | 'nin' | null
  kyc_submitted_at: string | null
  kyc_verified_at: string | null
  xend_member_id: string | null
  transaction_pin_hash: string | null
  pin_set_at: string | null
  created_at: string
}

export interface Wallet {
  id: string
  user_id: string
  deposit_address: string | null
  naira_balance_kobo: number
  usdc_balance_micro: number
  cngn_pool_micro: number
  cngn_yield_earned_micro: number
  total_saved_kobo: number
  total_withdrawn_kobo: number
  updated_at: string
}

export interface Transaction {
  id: string
  user_id: string
  type:
    | 'deposit'
    | 'withdrawal'
    | 'save_to_vault'
    | 'vault_withdraw'
    | 'esusu_contribute'
    | 'esusu_payout'
    | 'emergency_payout'
    | 'split_auto_save'
    | 'split_auto_esusu'
  direction: 'credit' | 'debit'
  amount_kobo: number
  amount_usdc_micro: number | null
  description: string
  reference: string | null
  paychant_tx_id: string | null
  status: 'pending' | 'completed' | 'failed'
  created_at: string
}

export interface SplitRule {
  id: string
  user_id: string
  name: string
  vault_percent: number
  naira_percent: number
  esusu_percent: number
  esusu_group_id: string | null
  min_amount_kobo: number
  active: boolean
  created_at: string
}

export interface EsusuGroup {
  id: string
  name: string
  owner_id: string
  contribution_amount_kobo: number
  cycle_period: 'daily' | 'weekly' | 'biweekly' | 'monthly'
  max_members: number
  current_cycle: number
  pot_balance_kobo: number
  emergency_pot_kobo: number
  status: 'forming' | 'active' | 'completed'
  created_at: string
}

export interface EsusuMember {
  id: string
  group_id: string
  user_id: string
  payout_position: number
  joined_at: string
}

export interface EsusuContribution {
  id: string
  group_id: string
  member_id: string
  cycle_number: number
  amount_kobo: number
  paid_at: string
}

export interface EmergencyRequest {
  id: string
  group_id: string
  requester_id: string
  reason: string
  amount_kobo: number
  status: 'voting' | 'approved' | 'rejected' | 'disbursed'
  created_at: string
}

export interface EmergencyVote {
  id: string
  request_id: string
  voter_id: string
  approve: boolean
  voted_at: string
}

export interface SavingsLock {
  id: string
  user_id: string
  amount_usdc_micro: number
  amount_kobo: number
  apy_percent: number
  duration_days: number
  projected_interest_micro: number
  locked_at: string
  unlocks_at: string
  status: 'active' | 'matured' | 'withdrawn' | 'early_withdrawn'
  matured_at: string | null
  withdrawn_at: string | null
  created_at: string
}

export interface PlatformFee {
  id: string
  user_id: string
  transaction_ref: string
  fee_type: 'ramp_onramp' | 'ramp_offramp' | 'vault_lock_penalty' | 'esusu_penalty' | 'admin_revenue_withdrawal'
  gross_amount_kobo: number
  fee_amount_kobo: number
  fee_percent: number
  created_at: string
}

export interface PlatformSetting {
  key: string
  value: string
  description: string | null
  updated_at: string
}

export interface AdminFeeSummary {
  total_fees_kobo: number
  total_onramp_fees: number
  total_offramp_fees: number
  total_penalty_fees: number
  fee_count: number
  today_fees_kobo: number
  this_month_fees_kobo: number
}

export interface SavingsGoal {
  id: string
  user_id: string
  title: string
  target_naira_kobo: number
  target_usdc_micro: number
  frequency: 'daily' | 'weekly' | 'monthly'
  contribution_naira_kobo: number
  contribution_usdc_micro: number
  saved_naira_kobo: number
  saved_usdc_micro: number
  interest_earned_micro: number
  status: 'active' | 'completed' | 'broken'
  started_at: string
  last_contributed_at: string | null
  completed_at: string | null
  created_at: string
}

export interface AdminUserStats {
  total_users: number
  total_wallets: number
  total_naira_kobo: number
  total_usdc_micro: number
  total_locked_usdc_micro: number
  active_locks: number
}

export interface AdminTxVolume {
  total_deposits_kobo: number
  total_withdrawals_kobo: number
  total_vault_saves_kobo: number
  total_tx_count: number
  pending_count: number
}

export interface EsusuCryptoDeposit {
  id: string
  group_id: string
  member_id: string
  user_id: string
  wallet_address: string
  amount_cngn_micro: number
  tx_hash: string | null
  status: 'pending' | 'confirmed' | 'failed'
  created_at: string
}
