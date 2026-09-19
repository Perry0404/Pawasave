# PawaSave — self-hosting runbook (Coolify on a VPS)

Target: your own box, Cloudflare in front, flat cost, secrets you control.

> **Status, 07 Sep 2026.** Cutover is done. Coolify on Hetzner is serving production
> and Vercel is no longer in use. Sections 1 to 7 are historical. Sections 4, 8 and 9
> have been corrected below, they described the pre-cutover state and were misleading.

---

## 0. Prereqs (before touching hosting)
- [ ] Back up `.env.recovery` → password manager. (Then have Claude delete the file.)
- [ ] Recover `DEPOSIT_MNEMONIC_KEY` via the encrypt-and-export step; back it up.
- [ ] Confirm the 4 wallet keys are in your password manager.

## 1. Provision the box
- Hetzner **CX22** (2 vCPU / 4 GB, ~€5/mo) or CPX21 for headroom. Region close to users/Supabase.
- Ubuntu 22.04/24.04 LTS.

## 2. Harden the box (do this first)
```sh
# as root
adduser deploy && usermod -aG sudo deploy
# copy your SSH public key to /home/deploy/.ssh/authorized_keys
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/;s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
ufw default deny incoming && ufw allow OpenSSH && ufw allow 443/tcp && ufw allow 80/tcp && ufw enable
apt update && apt install -y fail2ban unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades
timedatectl set-timezone UTC   # cron schedules assume UTC
```

## 3. Install Coolify
```sh
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```
Open `https://<server-ip>:8000`, create the admin account, **enable 2FA**.
Restrict the Coolify dashboard port (8000) to your IP in `ufw`, or reach it via Cloudflare Tunnel.

## 4. Deploy the app
- New Resource → **Public/Private Git** → your repo, branch **`main`**.

> **Corrected 19 Sep 2026.** This section used to say "do not deploy `main`, it is roughly
> 110 commits behind" and told you to deploy `audit-v2-remediation-and-flint-onramp`. That
> was true when written and is now **inverted**: `main` is `origin/HEAD` and is ahead, and
> the audit branch only carries a few a11y and eslint commits that `main` lacks. Circles and
> Pay with Pawa exist on `main` only.
>
> The live Coolify app is correctly configured for `main`. Verified by probing the API:
> `/api/pawa/orders` and `/api/circles/{id}/chat` both return 401, not 404.
>
> Worth saying plainly because this stale paragraph caused a real misdiagnosis: it was read
> as evidence that two shipped features were dark in production, and they were not. Check
> the deployment, not this file.
- **Base Directory:** `frontend`  ·  **Build Pack:** Dockerfile (uses `frontend/Dockerfile`).
- Add all env vars per `ops/env-checklist.md`. Mark every `NEXT_PUBLIC_*` as **Build Variable**.
- Port: **3000** (the image listens on 3000). Set the domain to `pawasave.xyz`.
- Deploy. Watch the build; confirm the healthcheck goes green.

## 5. Cloudflare in front
- Add `pawasave.xyz` to Cloudflare (free plan). Update nameservers at your registrar.
- DNS: A record `@`/`www` → server IP, **proxied** (orange cloud).
- SSL/TLS mode: **Full (strict)**. Let Coolify issue the origin cert, or use Cloudflare Origin CA.
- Turn on: Always Use HTTPS, HSTS, Bot Fight Mode, and a basic WAF rate-limit rule on `/api/*`.

## 6. Crons (critical — money-moving)
```sh
sudo mkdir -p /opt/pawasave
sudo cp ops/cron/pawasave-cron.sh /opt/pawasave/ && sudo chmod +x /opt/pawasave/pawasave-cron.sh
sudo cp ops/cron/cron.env.example /opt/pawasave/cron.env   # fill in, then:
sudo chmod 600 /opt/pawasave/cron.env
```
- Create **11 checks at healthchecks.io** (one per job), paste UUIDs into `cron.env`,
  set each check's period+grace to match its schedule.
- Install: `sudo crontab ops/cron/crontab` (adjust paths if not `/opt/pawasave`).
- Verify: `sudo run-parts` not needed — manually run one:
  `. /opt/pawasave/cron.env && /opt/pawasave/pawasave-cron.sh /api/cron/scan-deposits "$HC_SCAN_DEPOSITS"` → expect exit 0 + a green ping.

## 7. Verify BEFORE cutover (point a temp hostname or /etc/hosts at the box)
- [ ] App loads, login works, home balances render.
- [ ] `/api/cron/*` return 200 with the Bearer secret (crons wired).
- [ ] A test deposit is detected + swept; a small test withdrawal reconciles.
- [ ] Webhooks: update Strails/Flipeet/Flint/Sense webhook URLs to the new host.
- [ ] Push, email (SMTP), KYC session all work.

## 8. Deploying and rolling back (current process)

**Pushing does not deploy.** There is no auto-deploy webhook wired, so a push to the
trunk sits there until someone triggers a build. Either wire the webhook or treat the
trigger as a required manual step.

Trigger a deploy:
```sh
# Frontend (pawasave.xyz). App UUID corrected 19 Sep 2026: the old
# vtzujghz9qygbzxb9cy0xqa9 was the retired Hetzner app and no longer exists.
curl -s -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "$COOLIFY_URL/api/v1/deploy?uuid=p48ker5rrujrq0sanfhgawk2"
```

> **Host moved to OVH.** `COOLIFY_URL` is now `http://51.254.220.4:8000`. The Hetzner box
> (`49.12.35.192`) still answers on :8000 but its app is down. That old IP matters for one
> reason: it is still the IP StraiLs' BVN validator accepts (see §9).
>
> Coolify's dashboard is served over plain HTTP on :8000, so `COOLIFY_TOKEN` crosses the
> internet unencrypted. Restrict :8000 to your IP in `ufw` or put it behind a Cloudflare
> Tunnel, per §3.

Confirm what is actually live, no credentials needed. The chunk hash changes on every
build, so this is the definitive check:
```sh
curl -s https://pawasave.xyz | grep -oE 'app/page-[a-f0-9]+\.js'
```
A build takes about 3.5 minutes end to end.

**Rollback.** Vercel is gone, so "flip DNS back" no longer exists. The path is to
redeploy the previous image from the Coolify dashboard. **This has not been tested.**
Verify it and record the steps and timing here before the next risky change.

## 9. OPEN: StraiLs BVN validation broken by the server move

**Status 19 Sep 2026: unresolved, waiting on StraiLs. New-user onboarding is down.**

Moving Hetzner → OVH changed our egress IP from `49.12.35.192` to `51.254.220.4`. StraiLs
allowlists by source IP, and the new IP propagated to their API gateway but **not** to their
BVN/identity-validation subsystem:

- `POST /manageipallowlist` add succeeded; `check` returns `isAllowed: true`, rule `51.254.x.x`
- reads work from the new IP: `/getbankscode` is fine, and `/api/ramp/status` reports
  `naira: available, provider: strails`
- `/onboarduser` fails at `bvn_validation` with
  *"Request originates from an IP not in the application's allowlist"*
  (requestIds `493bfa6e-44b8-49e2-b2a6-50db431acd78`, `02e99493-3ee7-4efe-830a-f47857d47414`)
- the account is now blocked: *"Too many failed BVN validation attempts (100% failure rate)"*

**Nothing in this repo can fix it.** `cf1b332` deliberately retired the Render relay so StraiLs
is called directly from the box's egress IP, which makes the IP infrastructure rather than
configuration. `STRAILS_BASE_URL` is correctly `https://beta.stablesrail.io/v1`.

Asked of StraiLs: propagate `51.254.220.4` to the BVN subsystem, and reset the failure-rate
block. Also ask whether BVN validation reads a **separate allowlist store** and how long
propagation takes, and ask them to keep **both** IPs allowlisted rather than swapping, so the
fallback below stays available.

**Blast radius.** Existing customers with a NUBAN can still deposit; the read path works. New
users cannot complete BVN onboarding, so they get no NUBAN and cannot pass KYC.

**We are not making it worse.** There are no retry loops on BVN validation, and the 3-minute
`strails-reconcile` cron only calls `onboardStatus(requestId)`, a status read, not
`/onboarduser`. Only user-initiated `strails/onboard` and the dark `ussd` route trigger a
validation.

**Break-glass, only if StraiLs is slow and signups matter more than the cleanup.** The Hetzner
box is still alive, so its already-accepted IP could front StraiLs BVN calls as a fixed-IP hop.
This reinstates exactly what `cf1b332` removed and puts money-path traffic through a box being
decommissioned. Not recommended; recorded so the option is known rather than rediscovered.

Note: `frontend/src/lib/strails.ts:13` still documents the egress IP as `49.12.35.192`. Stale,
harmless at runtime, and worth correcting at the next backend rebaseline.

## 10. Phase 2 (later) — custody-key isolation
Move signing (custody sweeps, withdrawals, oracle) to a **separate worker box** not
exposed to the internet, so a web-server breach can't reach `CUSTODY_PRIVATE_KEY`.
The web tier calls the worker over a private network. ~$5/mo extra. Optional but a real jump.
