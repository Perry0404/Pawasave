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
- New Resource → **Public/Private Git** → your repo, branch **`audit-v2-remediation-and-flint-onramp`**.

> **Do not deploy `main`.** It is roughly 110 commits behind and predates equities,
> loans, USSD and KYC. Deploying it would silently remove live features.
> The Coolify app is already configured for the correct branch.
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
curl -s -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "$COOLIFY_URL/api/v1/deploy?uuid=vtzujghz9qygbzxb9cy0xqa9"
```

Confirm what is actually live, no credentials needed. The chunk hash changes on every
build, so this is the definitive check:
```sh
curl -s https://pawasave.xyz | grep -oE 'app/page-[a-f0-9]+\.js'
```
A build takes about 3.5 minutes end to end.

**Rollback.** Vercel is gone, so "flip DNS back" no longer exists. The path is to
redeploy the previous image from the Coolify dashboard. **This has not been tested.**
Verify it and record the steps and timing here before the next risky change.

## 9. Phase 2 (later) — custody-key isolation
Move signing (custody sweeps, withdrawals, oracle) to a **separate worker box** not
exposed to the internet, so a web-server breach can't reach `CUSTODY_PRIVATE_KEY`.
The web tier calls the worker over a private network. ~$5/mo extra. Optional but a real jump.
