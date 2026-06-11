# PawaSave email templates

Branded HTML for Supabase's auth emails. These solve two things at once:
**welcome new users** (the confirm-signup email is the first touch) and **fix the
reset-password flow**. Supabase sends them through your SMTP — no extra code or
provider integration required.

| File | Paste into (Supabase Dashboard) |
|---|---|
| `confirm-signup.html` | Authentication → Emails → **Confirm signup** |
| `reset-password.html` | Authentication → Emails → **Reset Password** |

## 1. Make emails actually deliver (the "many signups at once" fix)

Supabase's built-in email is rate-limited to ~3–4/hour and is **not** for
production. Set up Custom SMTP:

**Auth → Emails → SMTP Settings → Enable Custom SMTP.** Use a transactional
provider (better deliverability + volume than Zoho Mail SMTP):

- **Resend** — `smtp.resend.com`, port `465`, user `resend`, pass = your API key.
- **ZeptoMail** — host/credentials from the ZeptoMail console (you already own the
  Zoho domain, so verification is quick).

Set the sender to a real mailbox on your verified domain, e.g.
`noreply@pawasave.xyz`, sender name `PawaSave`.

> Whichever provider you pick, **verify the `pawasave.xyz` domain** in it (SPF +
> DKIM DNS records) or mail lands in spam / is rejected.

## 2. Raise Supabase's own rate limit

Even with custom SMTP, Supabase caps auth emails per hour. **Auth → Rate Limits →
"Rate limit for sending emails"** — raise it to match your launch volume.

## 3. Fix the reset link (so it stops landing on the create-account page)

**Auth → URL Configuration:**
- Site URL: `https://pawasave.xyz`
- Redirect URLs — add: `https://pawasave.xyz/**`, `https://pawasave.xyz/reset-password`, `http://localhost:3001/**`

Without this, Supabase ignores our `redirectTo` and falls back to the Site URL,
which is exactly why reset links currently dump users on the sign-in screen.

## Notes
- `confirm-signup.html` greets the user by name via `{{ .Data.display_name }}`
  (we pass `display_name` at signup) and shows the confirm CTA — it's the welcome
  email. If you later disable email confirmation, move the welcome to a separate
  send (Supabase Send-Email Auth Hook) instead.
- Test after pasting: trigger a real signup + a password reset, then open the
  **newest** link (old links expire).
