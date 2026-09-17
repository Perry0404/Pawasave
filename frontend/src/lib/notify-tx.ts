/**
 * notify-tx.ts — branded email receipts for deposits and withdrawals.
 *
 * Sends the signed-in user a receipt when money lands (deposit) or leaves
 * (withdrawal), with the who/where details:
 *   • deposit    → sender name + source account (masked) + channel
 *   • withdrawal → destination bank + account name + account no (masked)
 *
 * Self-contained: own service-role client to look up the user's email/name; no-ops
 * safely if SMTP isn't configured. Account numbers are MASKED in email (mail can be
 * forwarded) — the in-app detail sheet shows them in full to the owner only.
 */
import { createClient } from '@supabase/supabase-js'
import { sendMail, mailerConfigured } from '@/lib/mailer'
import { siteBaseUrl } from '@/lib/site-url'

let _admin: any = null
function admin() {
  if (_admin) return _admin
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null
  _admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )
  return _admin
}

const naira = (ngn: number) => '₦' + Number(ngn || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Mask an account number: keep first 3 + last 3 (e.g. 8067117651 → 806•••651). */
export function maskAccount(a?: string | null): string {
  const s = String(a || '').replace(/\D/g, '')
  if (!s) return ''
  if (s.length <= 6) return s
  return `${s.slice(0, 3)}•••${s.slice(-3)}`
}

const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function recipient(userId: string): Promise<{ email: string; name: string } | null> {
  const a = admin()
  if (!a) return null
  const { data } = await a.from('profiles').select('display_name').eq('id', userId).maybeSingle()
  const { data: u } = await a.auth.admin.getUserById(userId)
  const email = u?.user?.email
  if (!email) return null
  const meta = (u.user.user_metadata || {}) as any
  const name = (data?.display_name || meta.name || meta.full_name || email.split('@')[0] || '').split(' ')[0]
  return { email, name }
}

function shell(opts: { heading: string; sub: string; amount: string; amountColor: string; rows: [string, string][]; note?: string }): string {
  const rowsHtml = opts.rows.filter(([, v]) => v).map(([k, v]) => `
    <tr>
      <td style="padding:9px 0;font-size:12.5px;color:#69726C;border-top:1px solid #EEF1EC">${esc(k)}</td>
      <td style="padding:9px 0;font-size:13px;font-weight:600;color:#131A15;text-align:right;border-top:1px solid #EEF1EC">${esc(v)}</td>
    </tr>`).join('')
  return `<!doctype html><html><body style="margin:0;background:#F2F5F1;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#131A15">
  <div style="max-width:520px;margin:0 auto;padding:28px 20px">
    <div style="background:linear-gradient(158deg,#0E7A50,#0A5537);border-radius:22px;padding:24px;color:#fff">
      <img src="https://pawasave.xyz/logo-email.png" width="46" height="46" alt="PawaSave" style="display:block;width:46px;height:46px;border-radius:12px;margin:0 0 12px" />
      <div style="font-size:12px;opacity:.85;letter-spacing:.08em;text-transform:uppercase">PawaSave</div>
      <div style="font-size:20px;font-weight:700;margin-top:6px">${esc(opts.heading)}</div>
    </div>
    <div style="background:#fff;border:1px solid #E7EBE5;border-top:0;border-radius:0 0 18px 18px;padding:22px 24px;margin-top:-6px">
      <div style="font-size:13px;color:#69726C">${esc(opts.sub)}</div>
      <div style="font-size:30px;font-weight:800;margin:6px 0 16px;color:${opts.amountColor}">${esc(opts.amount)}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rowsHtml}</table>
      ${opts.note ? `<p style="font-size:11.5px;color:#8A938C;line-height:1.6;margin:16px 0 0">${esc(opts.note)}</p>` : ''}
      <p style="font-size:11.5px;color:#8A938C;line-height:1.6;margin:14px 0 0">Not you? Contact <a href="mailto:support@pawasave.xyz" style="color:#0A6B42">support@pawasave.xyz</a> immediately.</p>
    </div>
    <p style="font-size:11px;color:#9AA39C;text-align:center;margin:14px 0 0">PawaSave · Save, Ajo, Invest &amp; Borrow · pawasave.xyz</p>
  </div></body></html>`
}

const when = (iso?: string) => new Date(iso || Date.now()).toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })

export interface DepositNotice {
  amountNgn: number
  senderName?: string | null
  senderAccount?: string | null
  channel?: string | null
  reference?: string | null
  dateISO?: string
}

export async function sendDepositEmail(userId: string, d: DepositNotice): Promise<void> {
  if (!mailerConfigured()) return
  const r = await recipient(userId)
  if (!r) return
  const from = d.senderName
    ? `${d.senderName}${d.senderAccount ? ` · ${maskAccount(d.senderAccount)}` : ''}`
    : (d.channel || 'Bank transfer')
  const html = shell({
    heading: 'Deposit received 🎉',
    sub: `Hi ${r.name}, money just landed in your PawaSave balance.`,
    amount: '+' + naira(d.amountNgn),
    amountColor: '#0A6B42',
    rows: [
      ['From', from],
      ['Channel', d.channel || 'Strails'],
      ['Date', when(d.dateISO)],
      ['Reference', d.reference || ''],
    ],
  })
  await sendMail({ to: r.email, subject: `You received ${naira(d.amountNgn)} on PawaSave`, html, text: `You received ${naira(d.amountNgn)} on PawaSave from ${from}. Ref ${d.reference || ''}.` })
}

export interface AjoContributeNotice {
  amountNgn: number
  groupName: string
  cycle?: number | null
  reference?: string | null
  dateISO?: string
}

export async function sendAjoContributeEmail(userId: string, c: AjoContributeNotice): Promise<void> {
  if (!mailerConfigured()) return
  const r = await recipient(userId)
  if (!r) return
  const html = shell({
    heading: 'Contribution received 🤝',
    sub: `Hi ${r.name}, your Ajo contribution to "${c.groupName}" is in. Keep it up!`,
    amount: '−' + naira(c.amountNgn),
    amountColor: '#131A15',
    rows: [
      ['Circle', c.groupName],
      ['Cycle', c.cycle != null ? String(c.cycle) : ''],
      ['Date', when(c.dateISO)],
      ['Reference', c.reference || ''],
    ],
    note: 'Every member contributes each cycle, and one member receives the pooled payout in turn. You’ll be notified when it’s your turn to receive.',
  })
  await sendMail({ to: r.email, subject: `Your ₦ contribution to "${c.groupName}" is in`, html, text: `You contributed ${naira(c.amountNgn)} to "${c.groupName}"${c.cycle != null ? ` (cycle ${c.cycle})` : ''} on PawaSave.` })
}

export interface AjoDefaulterNotice {
  action: 'debited' | 'strike' | 'removed'
  groupName: string
  cycle?: number | null
  amountNgn?: number
  strikes?: number
}

export async function sendAjoDefaulterEmail(userId: string, d: AjoDefaulterNotice): Promise<void> {
  if (!mailerConfigured()) return
  const r = await recipient(userId)
  if (!r) return
  let heading: string, sub: string, subject: string, amount = '', amountColor = '#131A15'
  if (d.action === 'debited') {
    heading = 'Ajo auto-contribution 🔄'
    sub = `Hi ${r.name}, we auto-collected your Ajo contribution to "${d.groupName}" so you don't miss your cycle.`
    amount = '−' + naira(d.amountNgn || 0)
    subject = `Auto-contributed ${naira(d.amountNgn || 0)} to "${d.groupName}"`
  } else if (d.action === 'strike') {
    heading = `Missed Ajo contribution ⚠️ (strike ${d.strikes}/3)`
    sub = `Hi ${r.name}, we couldn't collect your ${naira(d.amountNgn || 0)} contribution to "${d.groupName}" — not enough balance. Fund your wallet before the next cycle. After 3 misses you'll be removed from the circle.`
    amountColor = '#B45309'
    subject = `Ajo contribution missed — strike ${d.strikes}/3 ("${d.groupName}")`
  } else {
    heading = 'Removed from Ajo circle'
    sub = `Hi ${r.name}, you've been removed from "${d.groupName}" after 3 missed contributions. The circle creator can add you back — reach out to them.`
    amountColor = '#B42318'
    subject = `Removed from "${d.groupName}" after 3 missed contributions`
  }
  const html = shell({
    heading, sub, amount, amountColor,
    rows: [
      ['Circle', d.groupName],
      ['Cycle', d.cycle != null ? String(d.cycle) : ''],
      ...(d.strikes ? [['Strikes', `${d.strikes}/3`] as [string, string]] : []),
    ],
  })
  await sendMail({ to: r.email, subject, html, text: sub })
}

export interface WithdrawalNotice {
  amountNgn: number
  bankName?: string | null
  accountName?: string | null
  accountNumber?: string | null
  reference?: string | null
  dateISO?: string
}

export async function sendWithdrawalEmail(userId: string, w: WithdrawalNotice): Promise<void> {
  if (!mailerConfigured()) return
  const r = await recipient(userId)
  if (!r) return
  const html = shell({
    heading: 'Withdrawal sent',
    sub: `Hi ${r.name}, your withdrawal was sent to the bank account below.`,
    amount: '−' + naira(w.amountNgn),
    amountColor: '#131A15',
    rows: [
      ['To bank', w.bankName || ''],
      ['Account name', w.accountName || ''],
      ['Account no', maskAccount(w.accountNumber)],
      ['Date', when(w.dateISO)],
      ['Reference', w.reference || ''],
    ],
    note: 'Bank settlement usually completes within minutes. If the recipient hasn’t received it after a while, reply to this email.',
  })
  await sendMail({ to: r.email, subject: `You sent ${naira(w.amountNgn)} from PawaSave`, html, text: `You sent ${naira(w.amountNgn)} to ${w.accountName || ''} (${w.bankName || ''}, ${maskAccount(w.accountNumber)}). Ref ${w.reference || ''}.` })
}

/** Trim a share count to a readable precision (stocks are fractional, e.g. 0.00219349). */
const fmtShares = (n: number) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 6 })

export interface EquityBuyNotice {
  symbol: string
  shares: number
  investedNgn: number
  reference?: string | null
  dateISO?: string
}

export async function sendEquityBuyEmail(userId: string, b: EquityBuyNotice): Promise<void> {
  if (!mailerConfigured()) return
  const r = await recipient(userId)
  if (!r) return
  const html = shell({
    heading: `You own a piece of ${esc(b.symbol)} 🎉`,
    sub: `Way to go, ${r.name}! Your order filled and the shares are now in your PawaSave portfolio.`,
    amount: `${fmtShares(b.shares)} ${b.symbol}`,
    amountColor: '#0A6B42',
    rows: [
      ['Stock', b.symbol],
      ['Shares', fmtShares(b.shares)],
      ['Invested', naira(b.investedNgn)],
      ['Date', when(b.dateISO)],
      ['Reference', b.reference || ''],
    ],
    note: 'Prices move with the market — track your holding any time in the Invest tab. Welcome to the markets! 📈',
  })
  await sendMail({
    to: r.email,
    subject: `🎉 You just bought ${fmtShares(b.shares)} ${b.symbol}`,
    html,
    text: `Congrats ${r.name}! You bought ${fmtShares(b.shares)} ${b.symbol} for ${naira(b.investedNgn)} on PawaSave. Ref ${b.reference || ''}.`,
  })
}

export interface InvestmentBuyNotice {
  name: string          // human product name, e.g. "Dangote Refinery IPO"
  symbol: string        // on-chain symbol, e.g. "DPRI"
  units: number         // token units bought
  investedNgn: number   // net cNGN that bought the asset
  feeNgn?: number       // PawaSave platform fee (if any)
  reference?: string | null
  dateISO?: string
}

/** Buy receipt for a GetEquity regulated investment (IPO / T-bill / fund). */
export async function sendInvestmentBuyEmail(userId: string, b: InvestmentBuyNotice): Promise<void> {
  if (!mailerConfigured()) return
  const r = await recipient(userId)
  if (!r) return
  const rows: [string, string][] = [
    ['Investment', b.name],
    ['Symbol', b.symbol],
    ['Units', fmtShares(b.units)],
    ['Invested', naira(b.investedNgn)],
  ]
  if (b.feeNgn && b.feeNgn > 0) rows.push(['Fee', naira(b.feeNgn)])
  rows.push(['Date', when(b.dateISO)], ['Reference', b.reference || ''])
  const html = shell({
    heading: `You invested in ${esc(b.name)} 🎉`,
    sub: `Nice one, ${r.name}! Your order filled and the position is now in your PawaSave portfolio.`,
    amount: `${fmtShares(b.units)} ${esc(b.symbol)}`,
    amountColor: '#0A6B42',
    rows,
    note: 'Track your holding any time in the Invest tab. 📈',
  })
  await sendMail({
    to: r.email,
    subject: `🎉 You invested in ${b.name}`,
    html,
    text: `Congrats ${r.name}! You invested ${naira(b.investedNgn)} in ${b.name} (${fmtShares(b.units)} ${b.symbol}) on PawaSave. Ref ${b.reference || ''}.`,
  })
}

export interface EquitySellNotice {
  symbol: string
  shares: number
  netNgn: number
  feeNgn: number
  reference?: string | null
  dateISO?: string
}

export async function sendEquitySellEmail(userId: string, s: EquitySellNotice): Promise<void> {
  if (!mailerConfigured()) return
  const r = await recipient(userId)
  if (!r) return
  const html = shell({
    heading: `Sold! ${esc(s.symbol)} cashed out 💚`,
    sub: `Nice one, ${r.name}! Your ${s.symbol} sale went through and the cash is in your PawaSave balance.`,
    amount: '+' + naira(s.netNgn),
    amountColor: '#0A6B42',
    rows: [
      ['Stock', s.symbol],
      ['Shares sold', fmtShares(s.shares)],
      ['Trading fee', naira(s.feeNgn)],
      ['Credited', naira(s.netNgn)],
      ['Date', when(s.dateISO)],
      ['Reference', s.reference || ''],
    ],
    note: 'Your cNGN is ready to spend, save, or reinvest. Thanks for trading with PawaSave! 🚀',
  })
  await sendMail({
    to: r.email,
    subject: `💚 You sold ${s.symbol} — ${naira(s.netNgn)} credited`,
    html,
    text: `Nice, ${r.name}! You sold ${fmtShares(s.shares)} ${s.symbol} on PawaSave. ${naira(s.netNgn)} credited (after ${naira(s.feeNgn)} fee). Ref ${s.reference || ''}.`,
  })
}

// ── Peer-to-peer transfers ───────────────────────────────────────────────────

export interface P2pSentNotice {
  amountNgn: number
  toLabel: string          // recipient name or email
  kind: 'direct' | 'claim'
  note?: string | null
  expiresAt?: string | null // claim only
  reference?: string | null
  dateISO?: string
}

/** Receipt to the SENDER when they send money to a person. */
export async function sendP2pSentEmail(userId: string, p: P2pSentNotice): Promise<void> {
  if (!mailerConfigured()) return
  const r = await recipient(userId)
  if (!r) return
  const claim = p.kind === 'claim'
  const html = shell({
    heading: claim ? 'Money sent — awaiting claim ⏳' : 'Money sent 💸',
    sub: claim
      ? `Hi ${r.name}, we've emailed ${esc(p.toLabel)} to claim it. If they don't claim it by the date below, it's returned to your balance automatically.`
      : `Hi ${r.name}, your transfer to ${esc(p.toLabel)} went through instantly.`,
    amount: '−' + naira(p.amountNgn),
    amountColor: '#131A15',
    rows: [
      ['To', p.toLabel],
      ['Type', claim ? 'Pending claim' : 'PawaSave friend'],
      ...(p.note ? [['Note', p.note] as [string, string]] : []),
      ...(claim && p.expiresAt ? [['Returns if unclaimed', when(p.expiresAt)] as [string, string]] : []),
      ['Date', when(p.dateISO)],
      ['Reference', p.reference || ''],
    ],
    note: claim ? 'You can cancel a pending transfer any time before it’s claimed to get your money back instantly.' : undefined,
  })
  await sendMail({
    to: r.email,
    subject: claim ? `You sent ${naira(p.amountNgn)} to ${p.toLabel} (awaiting claim)` : `You sent ${naira(p.amountNgn)} to ${p.toLabel}`,
    html,
    text: `You sent ${naira(p.amountNgn)} to ${p.toLabel} on PawaSave${claim ? ' — awaiting claim' : ''}. Ref ${p.reference || ''}.`,
  })
}

export interface P2pReceivedNotice {
  amountNgn: number
  fromLabel: string        // sender name
  note?: string | null
  reference?: string | null
  dateISO?: string
}

/** Receipt to an EXISTING user who received money (direct transfer, or a completed claim). */
export async function sendP2pReceivedEmail(userId: string, p: P2pReceivedNotice): Promise<void> {
  if (!mailerConfigured()) return
  const r = await recipient(userId)
  if (!r) return
  const html = shell({
    heading: 'You got money 🎉',
    sub: `Hi ${r.name}, ${esc(p.fromLabel)} sent you money on PawaSave. It’s in your balance now.`,
    amount: '+' + naira(p.amountNgn),
    amountColor: '#0A6B42',
    rows: [
      ['From', p.fromLabel],
      ...(p.note ? [['Note', p.note] as [string, string]] : []),
      ['Date', when(p.dateISO)],
      ['Reference', p.reference || ''],
    ],
  })
  await sendMail({
    to: r.email,
    subject: `You received ${naira(p.amountNgn)} on PawaSave`,
    html,
    text: `${p.fromLabel} sent you ${naira(p.amountNgn)} on PawaSave. Ref ${p.reference || ''}.`,
  })
}

export interface P2pClaimInviteNotice {
  toEmail: string
  amountNgn: number
  senderName: string
  note?: string | null
  expiresAt?: string | null
}

/**
 * Invite email to a recipient who has NO account yet — the "money to your email" hook.
 * Deliberately NOT a one-click auto-credit link (that pattern is the #1 fintech phishing
 * vector): it points them to sign up / log in with THIS email, and the claim is only granted
 * server-side once their address is verified. No claim token in the URL.
 */
export async function sendP2pClaimInviteEmail(p: P2pClaimInviteNotice): Promise<void> {
  if (!mailerConfigured()) return
  const url = siteBaseUrl()
  const html = shell({
    heading: 'Someone sent you money 💚',
    sub: `${esc(p.senderName)} sent you money on PawaSave. Create a free PawaSave account with this email address (${esc(p.toEmail)}) to claim it — it lands straight in your balance.`,
    amount: '+' + naira(p.amountNgn),
    amountColor: '#0A6B42',
    rows: [
      ['From', p.senderName],
      ...(p.note ? [['Note', p.note] as [string, string]] : []),
      ...(p.expiresAt ? [['Claim before', when(p.expiresAt)] as [string, string]] : []),
    ],
    note: `Claim it at ${url} — sign up or log in with ${p.toEmail}. If you don’t claim it in time, it’s safely returned to the sender. PawaSave will never ask for your password or PIN by email.`,
  })
  await sendMail({
    to: p.toEmail,
    subject: `${p.senderName} sent you ${naira(p.amountNgn)} on PawaSave 💚`,
    html,
    text: `${p.senderName} sent you ${naira(p.amountNgn)} on PawaSave. Create an account with ${p.toEmail} at ${url} to claim it${p.expiresAt ? ` before ${when(p.expiresAt)}` : ''}. Unclaimed money is returned to the sender.`,
  })
}

/** Onboarding: tell the user their BVN verification failed, with how to fix + retry. */
export async function sendBvnFailedEmail(userId: string, reason?: string | null): Promise<void> {
  if (!mailerConfigured()) return
  const r = await recipient(userId)
  if (!r) return
  const url = siteBaseUrl()
  const html = shell({
    heading: 'BVN verification didn’t go through',
    sub: `Hi ${r.name}, we couldn’t verify your BVN to create your Naira account — the details didn’t match your bank records.`,
    amount: 'Action needed',
    amountColor: '#B45309',
    rows: [
      ['Reason', reason || 'BVN didn’t match your bank records'],
      ['What to do', 'Re-check and re-enter your 11-digit BVN'],
    ],
    note: `Dial *565*0# on the phone linked to your BVN to see the correct number, then try again at ${url}. We never store your BVN. If it keeps failing, just reply to this email and we’ll help.`,
  })
  await sendMail({
    to: r.email,
    subject: 'Your BVN verification didn’t go through — quick fix',
    html,
    text: `Hi ${r.name}, your BVN verification didn’t go through (${reason || 'details didn’t match your bank records'}). Re-check your 11-digit BVN (dial *565*0#) and try again at ${url}.`,
  })
}

/** Tell the sender their unclaimed transfer was returned (expiry) or their cancel refunded. */
export async function sendP2pRevertedEmail(userId: string, p: { amountNgn: number; toLabel: string; reason: 'expired' | 'cancelled'; reference?: string | null }): Promise<void> {
  if (!mailerConfigured()) return
  const r = await recipient(userId)
  if (!r) return
  const expired = p.reason === 'expired'
  const html = shell({
    heading: expired ? 'Transfer returned ↩️' : 'Transfer cancelled ↩️',
    sub: expired
      ? `Hi ${r.name}, ${esc(p.toLabel)} didn’t claim your transfer in time, so we’ve returned it to your balance.`
      : `Hi ${r.name}, you cancelled your pending transfer to ${esc(p.toLabel)}. It’s back in your balance.`,
    amount: '+' + naira(p.amountNgn),
    amountColor: '#0A6B42',
    rows: [
      ['Was going to', p.toLabel],
      ['Reason', expired ? 'Unclaimed — expired' : 'Cancelled by you'],
      ['Reference', p.reference || ''],
    ],
  })
  await sendMail({
    to: r.email,
    subject: expired ? `Your ${naira(p.amountNgn)} transfer was returned` : `Your ${naira(p.amountNgn)} transfer was cancelled`,
    html,
    text: `Your ${naira(p.amountNgn)} transfer to ${p.toLabel} was ${expired ? 'returned (unclaimed)' : 'cancelled'} on PawaSave. Ref ${p.reference || ''}.`,
  })
}