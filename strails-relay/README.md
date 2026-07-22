# strails-relay

A ~90-line service whose only job is to give Strails **one unchanging IP address** to
allowlist.

## Why it exists

Strails requires every API call to arrive from a pre-registered IP. Vercel serverless
egresses from a **rotating pool** of AWS IPs — we proved this: we registered
`3.90.203.4` via `/manageipallowlist`, waited past the stated 30s propagation, retried,
and still got `IP_NOT_ALLOWED` because the next call left from a different address.
Vercel's own Static IP add-on costs **$100/mo** *and* disables Fluid Compute's extended
function duration, which PawaSave's 60-second off-ramp/sweep/oracle routes depend on.

So: run this on any host with a stable outbound IP (~$7/mo), point PawaSave at it, and
allowlist its single IP.

```
PawaSave (Vercel)  --x-relay-secret-->  strails-relay (fixed IP)  --x-api-key-->  Strails
```

**Bonus:** the Strails API key lives here, not in Vercel — it never touches the
serverless environment.

## Deploy (Render — simplest, no server to patch)

1. Push this repo to GitHub.
2. Render → **New → Web Service** → pick the repo → **Root Directory: `strails-relay`**.
3. Build command: `npm install` · Start command: `npm start`.
4. Instance type: the cheapest paid tier (free tier sleeps and has no static IP).
5. Add environment variables:

   | Key | Value |
   |---|---|
   | `STRAILS_API_KEY` | your Strails key |
   | `RELAY_SECRET` | a long random string — generate with `openssl rand -hex 32` |
   | `STRAILS_BASE_URL` | `https://beta.stablesrail.io/v1` (sandbox) or the prod URL |

6. Deploy. Render shows the service's **static outbound IPs** under
   *Settings → Outbound IPs*. (Railway and Fly.io work the same way; a $5 Hetzner/DO
   box also works if you'd rather run it yourself.)

## Wire it up

Confirm the IP the relay actually calls out from:

```bash
curl -H "x-relay-secret: $RELAY_SECRET" https://<your-relay>/whoami
# -> { "egressIp": "13.x.x.x", "allowlistThis": "13.x.x.x", ... }
```

Register that IP with Strails:

```bash
curl -X POST https://<your-relay>/manageipallowlist \
  -H "x-relay-secret: $RELAY_SECRET" -H "content-type: application/json" \
  -d '{"action":"add","ipAddress":"13.x.x.x"}'
```

Then verify end-to-end — this should return your real fintech account
(`9224290044 / Optimus Bank`):

```bash
curl -H "x-relay-secret: $RELAY_SECRET" https://<your-relay>/getfintechvirtualaccount
```

Finally, in Vercel set:

| Key | Value |
|---|---|
| `STRAILS_BASE_URL` | `https://<your-relay>` |
| `STRAILS_RELAY_SECRET` | the same `RELAY_SECRET` |

`frontend/src/lib/strails.ts` sends `x-relay-secret` automatically when
`STRAILS_RELAY_SECRET` is set, so no other code changes are needed.

## Security

- Forwards **only** to the configured `STRAILS_BASE_URL` — not an open proxy.
- Requires the shared secret on every route except `/health`; compared in constant time.
- Path is regex-validated before forwarding.
- Never logs request bodies or the API key.