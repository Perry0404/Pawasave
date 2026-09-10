/**
 * statement-html.ts — builds a branded, printable PawaSave account statement.
 *
 * Pure string builder (no DOM / no client-only deps) so it can be used both:
 *   • server-side in /api/statement to email the statement, and
 *   • as the document opened in a print window (Save as PDF) in the app.
 *
 * All styling is INLINE so it survives email clients (Gmail strips <style>).
 * The logo, signature and seal are hosted PNGs — email can't embed local files.
 */
const ORIGIN = 'https://pawasave.xyz'

export interface StatementRow {
  dateISO: string
  description: string
  type: string
  status: string
  inKobo: number
  outKobo: number
}

export interface StatementData {
  holderName: string
  email: string
  accountId: string
  periodLabel: string
  generatedAtISO: string
  rows: StatementRow[]
  totalInKobo: number
  totalOutKobo: number
  availableBalanceKobo: number
}

const naira = (k: number) =>
  '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const esc = (s: string) =>
  (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const prettyType = (t: string) =>
  (t || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('en-NG', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const statusColor = (s: string) =>
  s === 'completed' ? '#0A6B42' : s === 'pending' ? '#B7791F' : '#B42318'

export function buildStatementHtml(d: StatementData): string {
  const net = d.totalInKobo - d.totalOutKobo
  const rowsHtml = d.rows.length
    ? d.rows.map((r, i) => `
      <tr style="background:${i % 2 ? '#F7F9F6' : '#ffffff'}">
        <td style="padding:9px 10px;font-size:11.5px;color:#3a423c;white-space:nowrap;border-bottom:1px solid #EEF1EC">${fmtDate(r.dateISO)}</td>
        <td style="padding:9px 10px;font-size:12px;color:#131A15;border-bottom:1px solid #EEF1EC">${esc(r.description)}<div style="font-size:10.5px;color:#8A938C;margin-top:1px">${esc(prettyType(r.type))}</div></td>
        <td style="padding:9px 10px;font-size:11px;color:${statusColor(r.status)};text-transform:capitalize;border-bottom:1px solid #EEF1EC;white-space:nowrap">${esc(r.status === 'pending' ? 'processing' : r.status)}</td>
        <td style="padding:9px 10px;font-size:12px;color:#0A6B42;font-weight:600;text-align:right;border-bottom:1px solid #EEF1EC;white-space:nowrap">${r.inKobo ? naira(r.inKobo) : '—'}</td>
        <td style="padding:9px 10px;font-size:12px;color:#131A15;font-weight:600;text-align:right;border-bottom:1px solid #EEF1EC;white-space:nowrap">${r.outKobo ? naira(r.outKobo) : '—'}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" style="padding:26px;text-align:center;color:#8A938C;font-size:12.5px">No transactions in this period.</td></tr>`

  const summaryCard = (label: string, value: string, color: string) => `
    <td style="padding:0 6px" width="25%">
      <div style="background:#F2F5F1;border:1px solid #E7EBE5;border-radius:12px;padding:12px 12px">
        <div style="font-size:10.5px;color:#69726C;text-transform:uppercase;letter-spacing:.06em">${label}</div>
        <div style="font-size:15px;font-weight:700;color:${color};margin-top:5px;white-space:nowrap">${value}</div>
      </div>
    </td>`

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PawaSave Statement</title></head>
  <body style="margin:0;background:#EDF0EA;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#131A15">
    <div style="max-width:720px;margin:0 auto;padding:20px 16px">
      <div style="background:#ffffff;border:1px solid #E4E8E0;border-radius:18px;overflow:hidden">

        <!-- Header -->
        <div style="background:linear-gradient(158deg,#0E7A50,#0A5537);padding:22px 24px;color:#fff">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td>
              <img src="${ORIGIN}/logo-email.png" width="46" height="46" alt="PawaSave" style="display:block;width:46px;height:46px;border-radius:12px;margin-bottom:10px" />
              <div style="font-size:12px;opacity:.85;letter-spacing:.08em;text-transform:uppercase">PawaSave</div>
              <div style="font-size:21px;font-weight:700;margin-top:4px">Account Statement</div>
            </td>
            <td align="right" style="vertical-align:top;font-size:11.5px;line-height:1.7;opacity:.92">
              <div>${esc(d.periodLabel)}</div>
              <div>Generated ${fmtDate(d.generatedAtISO)}</div>
            </td>
          </tr></table>
        </div>

        <!-- Holder -->
        <div style="padding:18px 24px;border-bottom:1px solid #EEF1EC">
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12.5px;line-height:1.7">
            <tr>
              <td style="vertical-align:top">
                <div style="color:#8A938C;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em">Account holder</div>
                <div style="font-weight:700;font-size:15px;margin-top:2px">${esc(d.holderName)}</div>
                <div style="color:#3a423c">${esc(d.email)}</div>
              </td>
              <td align="right" style="vertical-align:top">
                <div style="color:#8A938C;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em">Account ID</div>
                <div style="font-family:monospace;font-size:12px;margin-top:2px;color:#3a423c">${esc(d.accountId)}</div>
              </td>
            </tr>
          </table>
        </div>

        <!-- Summary -->
        <div style="padding:16px 18px 4px">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            ${summaryCard('Money In', naira(d.totalInKobo), '#0A6B42')}
            ${summaryCard('Money Out', naira(d.totalOutKobo), '#131A15')}
            ${summaryCard('Net', (net >= 0 ? '+' : '−') + naira(Math.abs(net)), net >= 0 ? '#0A6B42' : '#B42318')}
            ${summaryCard('Available', naira(d.availableBalanceKobo), '#131A15')}
          </tr></table>
        </div>

        <!-- Transactions -->
        <div style="padding:14px 18px 6px">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #EEF1EC;border-radius:10px;overflow:hidden">
            <thead>
              <tr style="background:#0A5537;color:#fff">
                <th align="left" style="padding:9px 10px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:600">Date</th>
                <th align="left" style="padding:9px 10px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:600">Description</th>
                <th align="left" style="padding:9px 10px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:600">Status</th>
                <th align="right" style="padding:9px 10px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:600">Money In</th>
                <th align="right" style="padding:9px 10px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:600">Money Out</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <div style="font-size:11px;color:#8A938C;margin:8px 2px 0">${d.rows.length} transaction${d.rows.length === 1 ? '' : 's'} in this period.</div>
        </div>

        <!-- Signature / seal -->
        <div style="padding:14px 24px 8px">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:bottom">
              <img src="${ORIGIN}/signature.png" width="150" height="49" alt="" style="display:block;width:150px;height:auto" />
              <div style="border-top:1px solid #C9D0C6;width:190px;margin-top:2px;padding-top:5px;font-size:11.5px;color:#3a423c">
                <b>PawaSave Finance</b><br/>Authorized Signatory
              </div>
            </td>
            <td align="right" style="vertical-align:bottom">
              <img src="${ORIGIN}/seal.png" width="64" height="64" alt="Verified" style="display:block;width:64px;height:64px;margin-left:auto" />
            </td>
          </tr></table>
        </div>

        <!-- Footer -->
        <div style="padding:14px 24px 22px;border-top:1px solid #EEF1EC;margin-top:8px">
          <div style="font-size:10.5px;color:#8A938C;line-height:1.6">
            This is a computer-generated statement issued by PawaSave and is valid without a physical signature.
            All amounts are in Nigerian Naira (₦). For questions, contact
            <a href="mailto:support@pawasave.xyz" style="color:#0A6B42">support@pawasave.xyz</a>.
          </div>
          <div style="font-size:10.5px;color:#9AA39C;text-align:center;margin-top:12px">
            PawaSave · Save, Ajo, Invest &amp; Borrow · pawasave.xyz
          </div>
        </div>

      </div>
    </div>
  </body></html>`
}