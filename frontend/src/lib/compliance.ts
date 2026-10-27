import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * compliance.ts — account holds (migration 119).
 *
 *   review → nothing may leave the platform: withdrawals, P2P sends, Pay with Pawa, new loans.
 *   frozen → as review, and investing is blocked too.
 * Inflows are never blocked.
 *
 * The message is deliberately neutral. Telling a customer they are suspected or reported is
 * tipping-off under the Money Laundering (Prevention and Prohibition) Act 2022.
 *
 * Fails OPEN if the compliance columns are missing (migration 119 not yet applied), so a
 * deploy ahead of the migration never locks every customer out.
 */
export type ComplianceKind = 'exit' | 'invest'

export const COMPLIANCE_HOLD_MESSAGE =
  'Your account is under a routine review, so withdrawals and transfers are paused for now. ' +
  'Your money is safe. Contact support@pawasave.xyz if you need help.'

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export async function complianceStatus(userId: string): Promise<'clear' | 'review' | 'frozen'> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return 'clear'
  try {
    const { data, error } = await admin().from('profiles').select('compliance_status').eq('id', userId).maybeSingle()
    if (error) return 'clear'
    const s = (data as any)?.compliance_status
    return s === 'review' || s === 'frozen' ? s : 'clear'
  } catch {
    return 'clear'
  }
}

/** Unpaid Ajo debt in kobo (migration 123): a member removed from a circle after collecting,
 *  who still owes it. 0 if none, or if the function isn't there yet (fails open). */
export async function ajoDebtKobo(userId: string): Promise<number> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return 0
  try {
    const { data, error } = await admin().rpc('ajo_debt_owed_kobo', { p_user: userId })
    return error ? 0 : Number(data) || 0
  } catch {
    return 0
  }
}

/** Returns a 423 response if this account may not do `kind` right now, else null. */
export async function complianceBlock(userId: string, kind: ComplianceKind): Promise<NextResponse | null> {
  const s = await complianceStatus(userId)
  const blocked = s === 'frozen' || (s === 'review' && kind === 'exit')
  if (blocked) return NextResponse.json({ error: COMPLIANCE_HOLD_MESSAGE, code: 'compliance_hold' }, { status: 423 })

  // Money owed to an Ajo circle: no withdrawing, sending, paying or borrowing until it's settled.
  // Anything that comes in pays the circle first (123), so this keeps the debt collectable.
  if (kind === 'exit') {
    const owed = await ajoDebtKobo(userId)
    if (owed > 0) {
      const naira = `₦${(owed / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      return NextResponse.json({
        error: `You owe ${naira} to an Ajo circle you left after collecting. Withdrawals, transfers and loans are paused until it's paid. Money you add pays it automatically.`,
        code: 'ajo_debt', owedKobo: owed,
      }, { status: 423 })
    }
  }
  return null
}
