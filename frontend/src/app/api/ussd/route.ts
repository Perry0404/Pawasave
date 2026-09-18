import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { STRAILS_ENABLED, onboardUser } from '@/lib/strails'
import { hashPin, verifyPin } from '@/lib/pin-hash'

/**
 * POST /api/ussd — USSD gateway callback (Africa's Talking format).
 *
 * Feature-phone / agent onboarding + read-only banking. The gateway posts
 * form-encoded { sessionId, serviceCode, phoneNumber, text }; we reply text/plain
 * beginning with "CON " (keep the session open) or "END " (terminate).
 *
 * USSD is STATELESS per request: the gateway accumulates the user's inputs into `text`
 * joined by '*' (e.g. "PAWA-1A2B-008*22012345678"), so we parse the whole string each
 * time — no server session store needed.
 *
 * Flow (matches the product design):
 *   *111*PAWA-XXXX-008#         → validate invite code → prompt BVN
 *   (enter BVN)                 → create permanent account (Strails BVN onboard) +
 *                                 auto-join the Ajo circle the code belongs to
 *   *111#  (registered number)  → balance / Ajo / transactions / account (read-only)
 *
 * Money movement (save/withdraw/borrow) is deliberately NOT done over USSD yet — it
 * needs a hardened PIN-over-USSD flow — so those options point to the app.
 *
 * DARK until USSD_ENABLED='true'. Needs a USSD gateway + leased shortcode (e.g. Africa's
 * Talking) that posts here; optionally gate with USSD_GATEWAY_SECRET.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 30

function reply(body: string) {
  return new NextResponse(body, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
const CON = (t: string) => reply('CON ' + t)
const END = (t: string) => reply('END ' + t)

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })
}
const naira = (micro: unknown) => '₦' + Math.floor((Number(micro) || 0) / 1e6).toLocaleString()

export async function POST(req: NextRequest) {
  if (process.env.USSD_ENABLED !== 'true') return END('USSD banking is not available yet.')
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return END('Service temporarily unavailable.')

  // Optional shared-secret gate (configure the gateway to append ?s=... or send the header).
  const secret = process.env.USSD_GATEWAY_SECRET
  if (secret && req.nextUrl.searchParams.get('s') !== secret && req.headers.get('x-ussd-secret') !== secret) {
    return END('Unauthorized.')
  }

  const form = await req.formData().catch(() => null)
  const phone = String(form?.get('phoneNumber') || '').trim()
  const text = String(form?.get('text') || '').trim()
  if (!/^\+?\d{6,15}$/.test(phone)) return END('Invalid phone number.')

  const parts = text.length ? text.split('*') : []
  const db = admin()

  // ── Onboarding path: first input is an invite code ────────────────────────────
  const first = (parts[0] || '').toUpperCase()
  if (/^PAWA-[A-Z0-9]{2,8}-\d{2,4}$/.test(first)) {
    const { data: inv } = await db.from('ajo_invite_codes').select('code,status').eq('code', first).maybeSingle()
    if (!inv) return END('Invalid PawaSave code. Please check with your Ajo leader.')
    if (inv.status === 'claimed') return END('This invite code has already been used.')

    if (parts.length === 1) {
      return CON('Welcome to PawaSave.\nEnter your 11-digit BVN to create your account:')
    }
    if (parts.length >= 2) {
      const bvn = (parts[1] || '').replace(/\D/g, '')
      if (bvn.length !== 11) return END('BVN must be 11 digits. Dial again to retry.')
      if (!STRAILS_ENABLED) return END('Account creation is temporarily unavailable. Please try later.')

      try {
        // 1) find-or-create the user for this phone (the handle_new_user trigger makes the profile row)
        let userId: string
        const { data: prof } = await db.from('profiles').select('id').eq('phone', phone).maybeSingle()
        if (prof?.id) {
          userId = prof.id
        } else {
          const { data: created, error: cErr } = await db.auth.admin.createUser({
            phone, phone_confirm: true,
          } as any)
          if (cErr || !created?.user) throw new Error(cErr?.message || 'could not create account')
          userId = created.user.id
        }

        // 2) BVN onboarding via Strails — permanent NUBAN lands via the reconciler (webhook-independent)
        const bvnHash = crypto.createHash('sha256').update(bvn + (process.env.BVN_HASH_SALT || '')).digest('hex')
        const res = await onboardUser({ bvn, userId, phoneNumber: phone })
        await db.rpc('set_strails_onboarding', {
          p_user_id: userId, p_request_id: res.requestId || null, p_strails_uid: res.userHash || null,
          p_status: 'processing', p_bvn_hash: bvnHash,
        })

        // 3) join the Ajo circle the code belongs to
        await db.rpc('claim_ajo_invite', { p_code: first, p_user_id: userId })

        return END(
          'Welcome to PawaSave! Your Naira account is being created (about 2 minutes) and you have joined the Ajo circle. ' +
          'We will text you your account number.',
        )
      } catch (e) {
        return END('Sign-up could not be completed: ' + (e instanceof Error ? e.message : 'please try again later') + '.')
      }
    }
  }

  // ── Registered-user menu (identify by phone) ──────────────────────────────────
  const { data: profile } = await db
    .from('profiles')
    .select('id, display_name, strails_va_account_number, transaction_pin_hash')
    .eq('phone', phone)
    .maybeSingle()

  if (!profile) {
    return END('This number is not on PawaSave yet. Ask your Ajo leader for an invite code, then dial *111*CODE#.')
  }

  if (parts.length === 0) {
    return CON('PawaSave\n1. My balance\n2. My Ajo circles\n3. Contribute to Ajo\n4. Recent transactions\n5. My account\n6. Set/Change PIN\n7. Withdraw')
  }

  // 1 · balance
  if (parts[0] === '1') {
    const { data: w } = await db.from('wallets').select('naira_balance_kobo, usdc_balance_micro, cngn_pool_micro').eq('user_id', profile.id).maybeSingle()
    const spend = Math.floor((Number(w?.naira_balance_kobo) || 0) / 100 + (Number(w?.usdc_balance_micro) || 0) / 1e6)
    return END('PawaSave balance:\nSpendable: ₦' + spend.toLocaleString() + '\nSavings: ' + naira(w?.cngn_pool_micro))
  }

  // 2 · list Ajo circles
  if (parts[0] === '2') {
    const { data: mems } = await db.from('esusu_members').select('group_id').eq('user_id', profile.id)
    const ids = (mems || []).map((m: any) => m.group_id)
    if (!ids.length) return END('You are not in any Ajo circle yet.')
    const { data: grps } = await db.from('esusu_groups').select('name, contribution_amount_kobo, cycle_period').in('id', ids)
    const lines = (grps || []).map((g: any) => '- ' + g.name + ': ₦' + Math.floor(Number(g.contribution_amount_kobo) / 100).toLocaleString() + '/' + g.cycle_period)
    return END('Your Ajo circles:\n' + lines.join('\n'))
  }

  // 3 · contribute to an Ajo circle (PIN-gated) — reuses the app's esusu_contribute RPC
  if (parts[0] === '3') {
    const { data: mems } = await db.from('esusu_members').select('id, group_id').eq('user_id', profile.id)
    const memRows = (mems || []) as any[]
    if (!memRows.length) return END('You are not in any Ajo circle yet.')
    const { data: grps } = await db.from('esusu_groups').select('id, name, contribution_amount_kobo, current_cycle').in('id', memRows.map((m) => m.group_id))
    const groups = (grps || []) as any[]
    if (parts.length === 1) {
      const menu = groups.map((g, i) => (i + 1) + '. ' + g.name + ' (₦' + Math.floor(Number(g.contribution_amount_kobo) / 100).toLocaleString() + ')').join('\n')
      return CON('Contribute to which circle?\n' + menu)
    }
    const g = groups[parseInt(parts[1], 10) - 1]
    if (!g) return END('Invalid choice.')
    const mem = memRows.find((m) => m.group_id === g.id)
    const amt = Math.floor(Number(g.contribution_amount_kobo) / 100)
    if (!profile.transaction_pin_hash) return END('Set a PIN first (option 6), then contribute.')
    if (parts.length === 2) return CON('Enter your PIN to contribute ₦' + amt.toLocaleString() + ' to ' + g.name + ':')
    if (!verifyPin((parts[2] || '').replace(/\D/g, ''), profile.transaction_pin_hash).ok) return END('Incorrect PIN.')
    const { data: res, error } = await db.rpc('esusu_contribute', {
      p_user_id: profile.id, p_group_id: g.id, p_member_id: mem.id,
      p_amount_kobo: g.contribution_amount_kobo, p_cycle: g.current_cycle,
    })
    if (error) return END('Could not contribute: ' + error.message)
    if (res && (res as any).ok === false) return END((res as any).error || 'Could not contribute.')
    return END('Done! You contributed ₦' + amt.toLocaleString() + ' to ' + g.name + '.')
  }

  // 4 · recent transactions
  if (parts[0] === '4') {
    const { data: txs } = await db.from('transactions').select('type, amount_kobo, direction').eq('user_id', profile.id).order('created_at', { ascending: false }).limit(3)
    if (!txs?.length) return END('No transactions yet.')
    const lines = txs.map((t: any) => (t.direction === 'debit' ? '-' : '+') + '₦' + Math.floor(Number(t.amount_kobo) / 100).toLocaleString() + ' ' + String(t.type).replace(/_/g, ' '))
    return END('Recent activity:\n' + lines.join('\n'))
  }

  // 5 · account
  if (parts[0] === '5') {
    return END('Account: ' + (profile.strails_va_account_number || 'creating...') + '\nName: ' + (profile.display_name || '-'))
  }

  // 6 · set / change transaction PIN (authorises money actions)
  if (parts[0] === '6') {
    if (!profile.transaction_pin_hash) {
      if (parts.length === 1) return CON('Create a 4-digit PIN:')
      if (parts.length === 2) return CON('Confirm your 4-digit PIN:')
      const p1 = (parts[1] || '').replace(/\D/g, ''), p2 = (parts[2] || '').replace(/\D/g, '')
      if (!/^\d{4}$/.test(p1)) return END('PIN must be 4 digits. Dial again.')
      if (p1 !== p2) return END('PINs did not match. Dial again.')
      await db.from('profiles').update({ transaction_pin_hash: hashPin(p1), pin_set_at: new Date().toISOString() }).eq('id', profile.id)
      return END('Your PIN has been set. You can now contribute to Ajo.')
    }
    if (parts.length === 1) return CON('Enter your current PIN:')
    if (parts.length === 2) return CON('Enter a new 4-digit PIN:')
    if (!verifyPin((parts[1] || '').replace(/\D/g, ''), profile.transaction_pin_hash).ok) return END('Current PIN is incorrect.')
    const nw = (parts[2] || '').replace(/\D/g, '')
    if (!/^\d{4}$/.test(nw)) return END('New PIN must be 4 digits. Dial again.')
    await db.from('profiles').update({ transaction_pin_hash: hashPin(nw), pin_set_at: new Date().toISOString() }).eq('id', profile.id)
    return END('Your PIN has been changed.')
  }

  // 7 · withdraw — deferred to the app for now (USSD bank-withdrawal needs a hardened
  // bank-select + name-resolution + off-ramp flow; coming in a follow-up)
  if (parts[0] === '7') {
    return END('To withdraw to your bank, open the PawaSave app at pawasave.xyz. USSD withdrawal is coming soon.')
  }

  return END('Invalid option. Dial *111# to start again.')
}
