export interface Profile {
  id: string
  phone: string | null
  display_name: string
  created_at: string
}

export interface Wallet {
  id: string
  user_id: string
  naira_balance_kobo: number
  usdc_balance_micro: number
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
