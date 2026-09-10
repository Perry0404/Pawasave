import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { sendMail, mailerConfigured } from '@/lib/mailer'

/**
 * POST /api/welcome — send the one-time welcome email to the signed-in user, once.
 * Works for BOTH Google and email sign-ups: the client calls this on first app load;
 * the `welcome_sent` flag (migration 053) makes it idempotent. No-ops if SMTP is
 * not configured yet.
 */
function welcomeHtml(name: string): string {
  const hi = name ? `Hi ${name},` : 'Welcome,'
  return `<!doctype html><html><body style="margin:0;background:#F2F5F1;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#131A15">
  <div style="max-width:520px;margin:0 auto;padding:28px 20px">
    <div style="background:linear-gradient(158deg,#0E7A50,#0A5537);border-radius:22px;padding:26px 24px;color:#fff">
      <img src="https://pawasave.xyz/logo-email.png" width="52" height="52" alt="PawaSave"
        style="display:block;width:52px;height:52px;border-radius:14px;margin:0 0 14px" />
      <div style="font-size:13px;opacity:.85;letter-spacing:.08em;text-transform:uppercase">PawaSave</div>
      <div style="font-size:24px;font-weight:700;margin-top:8px">Welcome to PawaSave 🎉</div>
    </div>
    <div style="background:#fff;border:1px solid #E7EBE5;border-top:0;border-radius:0 0 18px 18px;padding:22px 24px;margin-top:-6px">
      <p style="font-size:15px;margin:0 0 12px">${hi}</p>
      <p style="font-size:14px;line-height:1.6;color:#3a423c;margin:0 0 14px">
        Your account is ready. PawaSave is your money app for Nigeria — save in cNGN and earn yield,
        run <b>Ajo</b> savings circles, invest in stocks, and borrow against your assets.
      </p>
      <p style="font-size:14px;line-height:1.6;color:#3a423c;margin:0 0 18px">
        A couple of things to do next:
      </p>
      <ul style="font-size:14px;line-height:1.7;color:#3a423c;margin:0 0 20px;padding-left:18px">
        <li>Set your <b>4-digit transaction PIN</b> (you'll need it to withdraw and borrow).</li>
        <li>Complete <b>identity verification (KYC)</b> so you can withdraw.</li>
        <li>Add money with <b>Receive</b> and start earning.</li>
      </ul>
      <a href="https://pawasave.xyz" style="display:inline-block;background:#0A6B42;color:#fff;text-decoration:none;font-weight:650;font-size:14px;padding:13px 22px;border-radius:12px">Open PawaSave</a>
      <p style="font-size:12px;color:#69726C;margin:22px 0 0;line-height:1.6">
        Need help? Reply to this email or reach us at
        <a href="mailto:support@pawasave.xyz" style="color:#0A6B42">support@pawasave.xyz</a>.
      </p>
    </div>
    <p style="font-size:11px;color:#9AA39C;text-align:center;margin:16px 0 0">
      PawaSave · Save, Ajo, Invest &amp; Borrow · pawasave.xyz
    </p>
  </div></body></html>`
}

export async function POST() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!user.email) return NextResponse.json({ ok: true, skipped: 'no email' })
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ ok: true, skipped: 'no service role' })
  if (!mailerConfigured()) return NextResponse.json({ ok: true, skipped: 'smtp not configured' })

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const { data: profile } = await admin.from('profiles').select('welcome_sent, display_name').eq('id', user.id).maybeSingle()
  if (profile?.welcome_sent) return NextResponse.json({ ok: true, already: true })

  // Prefer profile name, else Google metadata name, else email prefix.
  const meta = (user.user_metadata || {}) as any
  const name = (profile?.display_name || meta.name || meta.full_name || user.email.split('@')[0] || '').split(' ')[0]

  const sent = await sendMail({
    to: user.email,
    subject: 'Welcome to PawaSave 🎉',
    html: welcomeHtml(name),
    text: `Welcome to PawaSave! Your account is ready. Set your transaction PIN, complete KYC, and add money to start earning. Open https://pawasave.xyz — support@pawasave.xyz`,
  })
  if (sent) await admin.from('profiles').update({ welcome_sent: true }).eq('id', user.id)
  return NextResponse.json({ ok: true, sent })
}