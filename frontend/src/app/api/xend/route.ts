import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import {
  registerProxyMember,
  refreshProxyMemberToken,
  proxyFundsTransfer,
  validatePosInvoice,
  processPosInvoice,
} from '@/lib/xend'

async function getSupabaseUser() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return { user, supabase }
}

/**
 * POST /api/xend
 *
 * Actions:
 *   register      — register PawaSave user as Xend proxy member
 *   pool_deposit  — allocate USDC to Xend yield pool
 *   pool_withdraw — withdraw from Xend yield pool
 *   ramp_on       — on-ramp (fiat→crypto) via Xend POS agent
 *   ramp_off      — off-ramp (crypto→fiat) via Xend POS agent
 */
export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await getSupabaseUser()
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { action } = body

    switch (action) {
      /* ----- Register proxy member ----- */
      case 'register': {
        // Check if already registered
        const { data: profile } = await supabase
          .from('profiles')
          .select('display_name, xend_member_id')
          .eq('id', user.id)
          .single()

        if (profile?.xend_member_id) {
          return NextResponse.json({
            memberId: profile.xend_member_id,
            message: 'Already registered',
          })
        }

        const result = await registerProxyMember(user.id, {
          email: user.email,
          firstName: profile?.display_name || 'PawaSave',
          lastName: 'User',
          countryCode: 'NG',
        })

        // Store Xend memberId in profile
        await supabase
          .from('profiles')
          .update({ xend_member_id: result.data.memberId })
          .eq('id', user.id)

        return NextResponse.json({
          memberId: result.data.memberId,
          message: result.message,
        })
      }

      /* ----- Pool deposit (send USDC to Xend yield) ----- */
      case 'pool_deposit': {
        const { amountUsdcMicro } = body
        if (!amountUsdcMicro || amountUsdcMicro < 1000) {
          return NextResponse.json(
            { error: 'Minimum pool deposit is $0.001' },
            { status: 400 },
          )
        }

        // Get user's Xend memberId
        const { data: profile } = await supabase
          .from('profiles')
          .select('xend_member_id')
          .eq('id', user.id)
          .single()

        if (!profile?.xend_member_id) {
          return NextResponse.json(
            { error: 'Register with Xend first' },
            { status: 400 },
          )
        }

        // Convert micro-USDC to USDC (6 decimals)
        const amountUsdc = amountUsdcMicro / 1_000_000

        // Transfer from merchant custody to proxy member on Xend
        const result = await proxyFundsTransfer({
          proxyMemberId: profile.xend_member_id,
          action: 'CREDIT',
          amount: amountUsdc,
          description: 'PawaSave yield pool deposit',
        })

        // Debit user's local vault and allocate to pool
        await supabase.rpc('allocate_cngn_pool', {
          p_user_id: user.id,
          p_usdc_micro: amountUsdcMicro,
        })

        return NextResponse.json({
          transitWalletId: result.transitWallet._id,
          message: 'Deposited to Xend yield pool',
        })
      }

      /* ----- Pool withdraw (pull from Xend yield back to vault) ----- */
      case 'pool_withdraw': {
        const { amountUsdcMicro: withdrawMicro } = body
        if (!withdrawMicro || withdrawMicro < 1000) {
          return NextResponse.json(
            { error: 'Minimum withdrawal is $0.001' },
            { status: 400 },
          )
        }

        const { data: prof } = await supabase
          .from('profiles')
          .select('xend_member_id')
          .eq('id', user.id)
          .single()

        if (!prof?.xend_member_id) {
          return NextResponse.json(
            { error: 'Register with Xend first' },
            { status: 400 },
          )
        }

        const amountUsdc = withdrawMicro / 1_000_000

        // Transfer from proxy member back to merchant custody
        const result = await proxyFundsTransfer({
          proxyMemberId: prof.xend_member_id,
          action: 'DEBIT',
          amount: amountUsdc,
          description: 'PawaSave yield pool withdrawal',
        })

        // Credit user's local vault from pool
        await supabase.rpc('withdraw_cngn_pool', {
          p_user_id: user.id,
          p_usdc_micro: withdrawMicro,
        })

        return NextResponse.json({
          transitWalletId: result.transitWallet._id,
          message: 'Withdrawn from Xend yield pool',
        })
      }

      /* ----- On-ramp via Xend POS (fiat → crypto) ----- */
      case 'ramp_on': {
        const { amount: rampAmount, currency = 'USDC' } = body
        if (!rampAmount || rampAmount < 100) {
          return NextResponse.json(
            { error: 'Minimum ₦100' },
            { status: 400 },
          )
        }

        const { data: prof2 } = await supabase
          .from('profiles')
          .select('xend_member_id')
          .eq('id', user.id)
          .single()

        if (!prof2?.xend_member_id) {
          return NextResponse.json(
            { error: 'Register with Xend first' },
            { status: 400 },
          )
        }

        // Validate then process
        await validatePosInvoice(prof2.xend_member_id, {
          amount: 0,
          currency,
          fiatAmount: rampAmount,
          fiatCurrency: 'NGN',
        })

        const invoice = await processPosInvoice(prof2.xend_member_id, {
          amount: 0,
          currency,
          fiatAmount: rampAmount,
          fiatCurrency: 'NGN',
        })

        return NextResponse.json({
          invoiceId: invoice.data.invoiceId,
          walletAddress: invoice.data.walletAddress,
          amount: invoice.data.amount,
          currency: invoice.data.currency,
          network: invoice.data.network,
          status: invoice.data.status,
          message: 'On-ramp invoice created via Xend',
        })
      }

      /* ----- Off-ramp via Xend POS (crypto → fiat) ----- */
      case 'ramp_off': {
        const { amount: offAmount, currency: offCurrency = 'USDC' } = body
        if (!offAmount || offAmount < 100) {
          return NextResponse.json(
            { error: 'Minimum ₦100' },
            { status: 400 },
          )
        }

        const { data: prof3 } = await supabase
          .from('profiles')
          .select('xend_member_id')
          .eq('id', user.id)
          .single()

        if (!prof3?.xend_member_id) {
          return NextResponse.json(
            { error: 'Register with Xend first' },
            { status: 400 },
          )
        }

        await validatePosInvoice(prof3.xend_member_id, {
          amount: 0,
          currency: offCurrency,
          fiatAmount: offAmount,
          fiatCurrency: 'NGN',
        })

        const offInvoice = await processPosInvoice(prof3.xend_member_id, {
          amount: 0,
          currency: offCurrency,
          fiatAmount: offAmount,
          fiatCurrency: 'NGN',
        })

        return NextResponse.json({
          invoiceId: offInvoice.data.invoiceId,
          walletAddress: offInvoice.data.walletAddress,
          amount: offInvoice.data.amount,
          currency: offInvoice.data.currency,
          network: offInvoice.data.network,
          status: offInvoice.data.status,
          message: 'Off-ramp invoice created via Xend',
        })
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 },
        )
    }
  } catch (err: any) {
    console.error('Xend API route error:', err)
    return NextResponse.json(
      { error: err.message || 'Xend service error' },
      { status: 500 },
    )
  }
}
