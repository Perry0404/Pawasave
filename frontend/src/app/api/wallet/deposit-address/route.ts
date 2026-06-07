import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import { deriveDepositAddress, depositWalletConfigured } from '@/lib/deposit-wallet'

/**
 * GET /api/wallet/deposit-address
 * Returns the signed-in user's real Base cNGN deposit address, deriving and
 * persisting it from their deposit_index on first call.
 */
export async function GET() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  if (!depositWalletConfigured()) {
    return NextResponse.json({ error: 'Crypto deposits not configured' }, { status: 503 })
  }

  const { data: wallet } = await supabase
    .from('wallets')
    .select('deposit_index, deposit_address')
    .eq('user_id', user.id)
    .single()

  if (!wallet || wallet.deposit_index == null) {
    return NextResponse.json({ error: 'Wallet not ready' }, { status: 404 })
  }

  let address = wallet.deposit_address as string | null
  if (!address) {
    address = deriveDepositAddress(Number(wallet.deposit_index))
    await supabase.rpc('set_deposit_address', { p_user_id: user.id, p_address: address })
  }

  return NextResponse.json({ address })
}
