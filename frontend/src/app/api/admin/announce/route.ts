import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorisedAdmin } from '@/lib/admin-session'
import { sendAnnouncementEmail } from '@/lib/notify-tx'
import { sendPushToUser } from '@/lib/push-send'

/**
 * POST /api/admin/announce — send a product announcement to every user (email + push).
 *
 *   { password, campaign: 'tbills-14', dryRun: true }   → who would receive it, nothing sent
 *   { password, campaign: 'tbills-14', dryRun: false }  → send
 *
 * Campaigns are defined here, in code, so what goes out is reviewed like any other change.
 * Sends one at a time with a short pause (SMTP-friendly) and skips deleted accounts.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const CAMPAIGNS = {
  'tbills-14': {
    subject: 'New on PawaSave: Treasury Bills at 14% a year',
    heading: 'Treasury Bills, now on PawaSave',
    sub: 'Hi {name}, you can now invest in Nigerian Treasury Bills right inside PawaSave and earn 14% a year.',
    amount: '14% a year',
    rows: [
      ['What it is', 'Nigerian Treasury Bills, via GetEquity'],
      ['To start', 'From ₦1,000, no fee to buy'],
      ['Withdraw', 'Any day, paid to your balance'],
      ['Where', 'Invest tab → Treasury Bills'],
    ] as [string, string][],
    note: 'Returns are variable and come from the underlying Treasury Bills. Open the app and go to Invest to get started.',
    text: 'Hi {name}, you can now invest in Nigerian Treasury Bills inside PawaSave and earn 14% a year. From ₦1,000, no fee to buy, withdraw any day. Open the app and go to Invest → Treasury Bills.',
    push: { title: 'Treasury Bills at 14% a year', body: 'Now in PawaSave: from ₦1,000, no fee to buy, withdraw any day.', url: '/', tag: 'tbills-14' },
  },
} as const

export async function POST(request: NextRequest) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Service role key not configured' }, { status: 503 })
  const body = await request.json().catch(() => ({}))
  if (!isAuthorisedAdmin(request, body?.password)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const c = CAMPAIGNS[String(body?.campaign) as keyof typeof CAMPAIGNS]
  if (!c) return NextResponse.json({ error: 'Unknown campaign' }, { status: 400 })

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const ids: string[] = []
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error || !data?.users?.length) break
    for (const u of data.users) if (u.email && !/@deleted\.pawasave\.xyz$/i.test(u.email)) ids.push(u.id)
    if (data.users.length < 1000) break
  }
  if (body?.dryRun !== false) return NextResponse.json({ dryRun: true, recipients: ids.length, subject: c.subject })

  let sent = 0, failed = 0
  for (const id of ids) {
    const ok = await sendAnnouncementEmail(id, { subject: c.subject, heading: c.heading, sub: c.sub, amount: c.amount, rows: [...c.rows], note: c.note, text: c.text })
      .catch(() => false)
    if (ok) sent++; else failed++
    sendPushToUser(id, { ...c.push }).catch(() => {})
    await new Promise((r) => setTimeout(r, 400))
  }
  console.info('[admin/announce]', body.campaign, { sent, failed })
  return NextResponse.json({ ok: true, campaign: body.campaign, recipients: ids.length, sent, failed })
}
