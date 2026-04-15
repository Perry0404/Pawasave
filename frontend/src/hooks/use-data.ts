'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase'
import type { User } from '@supabase/supabase-js'
import type { Profile, Wallet, Transaction } from '@/lib/types'

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
      redirectTo: `${window.location.origin}`,
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
