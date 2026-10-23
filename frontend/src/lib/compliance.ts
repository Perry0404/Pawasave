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

/** Returns a 423 response if this account may not do `kind` right now, else null. */
export async function complianceBlock(userId: string, kind: ComplianceKind): Promise<NextResponse | null> {
  const s = await complianceStatus(userId)
  const blocked = s === 'frozen' || (s === 'review' && kind === 'exit')
  if (!blocked) return null
  return NextResponse.json({ error: COMPLIANCE_HOLD_MESSAGE, code: 'compliance_hold' }, { status: 423 })
}
