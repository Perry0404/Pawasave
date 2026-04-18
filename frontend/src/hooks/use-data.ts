'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase'
import type { User } from '@supabase/supabase-js'
import type { Profile, Wallet, Transaction, SavingsLock, PlatformSetting, AdminFeeSummary, AdminUserStats, AdminTxVolume, PlatformFee } from '@/lib/types'

const supabase = createClient()

export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  const signUp = async (email: string, password: string, displayName: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } },
    })
    if (error) throw error
    return data
  }

  const signIn = async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
  }

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  const resetPassword = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    })
    if (error) throw error
  }

  return { user, loading, signUp, signIn, signOut, resetPassword }
}

export function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(null)

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single()
    if (data) setProfile(data)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return { profile, refresh }
}

export function useWallet() {
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase.from('wallets').select('*').eq('user_id', user.id).single()
    if (data) setWallet(data)
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Subscribe to realtime changes
  useEffect(() => {
    const channel = supabase
      .channel('wallet-changes')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'wallets' }, () => {
        refresh()
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [refresh])

  return { wallet, loading, refresh }
}

export function useTransactions(limit = 50) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (data) setTransactions(data)
    setLoading(false)
  }, [limit])

  useEffect(() => { refresh() }, [refresh])

  // Realtime
  useEffect(() => {
    const channel = supabase
      .channel('tx-changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, () => {
        refresh()
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [refresh])

  return { transactions, loading, refresh }
}

// Wallet operations
export async function saveToVault(amountKobo: number, usdcMicro: number) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: ok, error } = await supabase.rpc('save_to_vault', {
    p_user_id: user.id,
    p_naira_kobo: amountKobo,
    p_usdc_micro: usdcMicro,
  })
  if (error) throw error
  if (!ok) throw new Error('Insufficient balance')

  // Record transaction
  await supabase.from('transactions').insert({
    user_id: user.id,
    type: 'save_to_vault',
    direction: 'debit',
    amount_kobo: amountKobo,
    amount_usdc_micro: usdcMicro,
    description: 'Saved to USDC vault',
    status: 'completed',
  })
}

export async function withdrawFromVault(amountKobo: number, usdcMicro: number) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: ok, error } = await supabase.rpc('withdraw_from_vault', {
    p_user_id: user.id,
    p_naira_kobo: amountKobo,
    p_usdc_micro: usdcMicro,
  })
  if (error) throw error
  if (!ok) throw new Error('Insufficient vault balance')

  await supabase.from('transactions').insert({
    user_id: user.id,
    type: 'vault_withdraw',
    direction: 'credit',
    amount_kobo: amountKobo,
    amount_usdc_micro: usdcMicro,
    description: 'Withdrew from USDC vault',
    status: 'completed',
  })
}

export async function createDepositTx(amountKobo: number, reference: string) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  await supabase.from('transactions').insert({
    user_id: user.id,
    type: 'deposit',
    direction: 'credit',
    amount_kobo: amountKobo,
    description: 'Deposit via FlintAPI',
    reference,
    status: 'pending',
  })
}

export async function createWithdrawalTx(amountKobo: number, reference: string) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  await supabase.from('transactions').insert({
    user_id: user.id,
    type: 'withdrawal',
    direction: 'debit',
    amount_kobo: amountKobo,
    description: 'Withdrawal via FlintAPI',
    reference,
    status: 'pending',
  })
}

// ── Savings Locks ──

export function useSavingsLocks() {
  const [locks, setLocks] = useState<SavingsLock[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase
      .from('savings_locks')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
    if (data) setLocks(data)
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return { locks, loading, refresh }
}

export async function lockSavings(usdcMicro: number, kobo: number, durationDays: number, apy: number) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data, error } = await supabase.rpc('lock_savings', {
    p_user_id: user.id,
    p_usdc_micro: usdcMicro,
    p_kobo: kobo,
    p_duration_days: durationDays,
    p_apy: apy,
  })
  if (error) throw error
  return data
}

export async function withdrawLock(lockId: string, early: boolean = false) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: ok, error } = await supabase.rpc('withdraw_lock', {
    p_user_id: user.id,
    p_lock_id: lockId,
    p_early: early,
  })
  if (error) throw error
  if (!ok) throw new Error('Lock not found or already withdrawn')
}

export async function getPlatformSettings(): Promise<PlatformSetting[]> {
  const { data } = await supabase.from('platform_settings').select('*')
  return data || []
}

export async function getMorphoApy(): Promise<number> {
  const { data } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'morpho_apy_percent')
    .single()
  return data ? parseFloat(data.value) : 4.0
}

// ── Admin (uses service role via API) ──

export async function getAdminFeeSummary(): Promise<AdminFeeSummary | null> {
  const { data, error } = await supabase.rpc('admin_fee_summary')
  if (error || !data || data.length === 0) return null
  return data[0]
}

export async function getAdminUserStats(): Promise<AdminUserStats | null> {
  const { data, error } = await supabase.rpc('admin_user_stats')
  if (error || !data || data.length === 0) return null
  return data[0]
}

export async function getAdminTxVolume(): Promise<AdminTxVolume | null> {
  const { data, error } = await supabase.rpc('admin_tx_volume')
  if (error || !data || data.length === 0) return null
  return data[0]
}

export async function getAdminRecentFees(limit = 50): Promise<PlatformFee[]> {
  const { data, error } = await supabase.rpc('admin_recent_fees', { p_limit: limit })
  if (error) return []
  return data || []
}

export async function isAdmin(): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return false
  const { data } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'admin_emails')
    .single()
  if (!data?.value) return false
  const emails = data.value.split(',').map((e: string) => e.trim().toLowerCase())
  return emails.includes(user.email.toLowerCase())
}
