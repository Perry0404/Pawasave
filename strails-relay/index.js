/**
 * strails-relay — a tiny fixed-IP relay between PawaSave (Vercel) and Strails.
 *
 * Why this exists: Strails requires every API call to come from a pre-allowlisted
 * IP, but Vercel serverless egresses from a rotating pool of AWS IPs (proven: we
 * registered one and the next call still came from another). This service runs on
 * a host with ONE stable outbound IP, so Strails only ever sees that address.
 *
 * It is a narrow relay, not an open proxy: it forwards ONLY to the configured
 * Strails base URL, and only to callers presenting the shared secret.
 *
 * The Strails API key lives HERE, not in Vercel — so it never sits in the
 * serverless environment at all.
 *
 * Env:
 *   STRAILS_API_KEY   required — your Strails key
 *   RELAY_SECRET      required — shared secret PawaSave must send (x-relay-secret)
 *   STRAILS_BASE_URL  optional — default https://beta.stablesrail.io/v1
 *   PORT              optional — default 8080
 */
import http from 'node:http'
import crypto from 'node:crypto'

const API_KEY = process.env.STRAILS_API_KEY || ''
const SECRET = process.env.RELAY_SECRET || ''
const BASE = (process.env.STRAILS_BASE_URL || 'https://beta.stablesrail.io/v1').replace(/\/$/, '')
const PORT = Number(process.env.PORT) || 8080

if (!API_KEY || !SECRET) {
  console.error('FATAL: STRAILS_API_KEY and RELAY_SECRET are required')
  process.exit(1)
}

/** Constant-time compare so the secret can't be guessed by timing. */
function secretOk(given) {
  if (typeof given !== 'string' || given.length !== SECRET.length) return false
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(SECRET))
}

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  // Liveness — no secret required.
  if (req.url === '/health') return send(res, 200, { ok: true })

  // Tells you the exact IP to give Strails. Secret-gated so it isn't public.
  if (req.url === '/whoami') {
    if (!secretOk(req.headers['x-relay-secret'])) return send(res, 401, { error: 'unauthorized' })
    try {
      const r = await fetch('https://api.ipify.org?format=json')
      const { ip } = await r.json()
      return send(res, 200, { egressIp: ip, allowlistThis: ip, base: BASE })
    } catch (e) {
      return send(res, 502, { error: 'could not determine egress IP', detail: String(e) })
    }
  }

  if (!secretOk(req.headers['x-relay-secret'])) return send(res, 401, { error: 'unauthorized' })

  // Everything else is forwarded verbatim to Strails.
  const path = (req.url || '/').split('?')[0]
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(path)) return send(res, 400, { error: 'bad path' })

  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)

  try {
    const upstream = await fetch(`${BASE}${path}`, {
      method: req.method,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      signal: AbortSignal.timeout(30_000),
    })
    const text = await upstream.text()
    res.writeHead(upstream.status, { 'content-type': 'application/json' })
    res.end(text)
  } catch (e) {
    send(res, 502, { error: 'upstream failed', detail: e instanceof Error ? e.message : String(e) })
  }
})

server.listen(PORT, () => console.log(`strails-relay listening on :${PORT} → ${BASE}`))