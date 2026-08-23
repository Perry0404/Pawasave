import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import { sendMail, mailerConfigured } from '@/lib/mailer'
import { buildStatementHtml, type StatementRow } from '@/lib/statement-html'

/**
 * POST /api/statement — generate a branded account statement for the signed-in user.
 * Body: { period?: '30d'|'90d'|'6m'|'all', delivery: 'view'|'email' }
 *   • delivery 'view'  → returns { html } for the app to open in a print window.
 *   • delivery 'email' → emails the statement (with logo + signature) to the user.
 * Reads transactions under the user's own session (RLS), so no service role needed.
 */
const PERIODS: Record<string, { days: number | null; label: string }> = {
  '30d': { days: 30, label: 'Last 30 days' },
  '90d': { days: 90, label: 'Last 90 days' },
  '6m': { days: 182, label: 'Last 6 months' },
  'all': { days: null, label: 'All transactions' },
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { period?: string; delivery?: string }
  const period = PERIODS[body.period || '90d'] || PERIODS['90d']
  const delivery = body.delivery === 'email' ? 'email' : 'view'

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Transactions in period (RLS restricts to the caller's own rows).
  let q = supabase
    .from('transactions')
    .select('type, direction, amount_kobo, description, status, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
  if (period.days !== null) {
    const start = new Date(Date.now() - period.days * 86400_000).toISOString()
    q = q.gte('created_at', start)
  }
  const { data: txs, error } = await q.limit(1000)
  if (error) return NextResponse.json({ error: 'Could not load transactions' }, { status: 500 })

  const [{ data: profile }, { data: wallet }] = await Promise.all([
    supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle(),
    supabase.from('wallets').select('naira_balance_kobo').eq('user_id', user.id).maybeSingle(),
  ])

  let totalIn = 0, totalOut = 0
  const rows: StatementRow[] = (txs || []).map((t: any) => {
    const credit = t.direction === 'credit'
    const amt = t.amount_kobo || 0
    if (credit) totalIn += amt; else totalOut += amt
    return {
      dateISO: t.created_at,
      description: t.description || (credit ? 'Received' : 'Sent'),
      type: t.type || '',
      status: t.status || 'completed',
      inKobo: credit ? amt : 0,
      outKobo: credit ? 0 : amt,
    }
  })

  const meta = (user.user_metadata || {}) as any
  const html = buildStatementHtml({
    holderName: profile?.display_name || meta.name || meta.full_name || (user.email?.split('@')[0] ?? 'PawaSave user'),
    email: user.email || '',
    accountId: user.id.slice(0, 8).toUpperCase(),
    periodLabel: period.label,
    generatedAtISO: new Date().toISOString(),
    rows,
    totalInKobo: totalIn,
    totalOutKobo: totalOut,
    availableBalanceKobo: wallet?.naira_balance_kobo || 0,
  })

  if (delivery === 'email') {
    if (!user.email) return NextResponse.json({ error: 'No email on file' }, { status: 400 })
    if (!mailerConfigured()) return NextResponse.json({ error: 'Email is not configured' }, { status: 503 })
    const sent = await sendMail({
      to: user.email,
      subject: `Your PawaSave statement — ${period.label}`,
      html,
      text: `Your PawaSave account statement (${period.label}) is attached as HTML. Money in: ₦${(totalIn / 100).toFixed(2)}, money out: ₦${(totalOut / 100).toFixed(2)}. View the app at https://pawasave.xyz`,
    })
    if (!sent) return NextResponse.json({ error: 'Could not send email' }, { status: 502 })
    return NextResponse.json({ ok: true, sent: true, email: user.email })
  }

  return NextResponse.json({ ok: true, html })
}