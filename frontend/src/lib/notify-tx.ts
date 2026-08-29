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