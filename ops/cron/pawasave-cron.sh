#!/usr/bin/env sh
# ─────────────────────────────────────────────────────────────────────────────
# PawaSave cron runner — replaces Vercel Cron on a self-hosted box.
# Calls one /api/cron/* endpoint with the Bearer secret and reports the outcome
# to healthchecks.io (a "dead man's switch": if a money-moving cron stops firing
# or starts failing, healthchecks pages you).
#
#   Usage:  pawasave-cron.sh <path> [healthcheck_uuid]
#   Env  :  BASE_URL       e.g. http://127.0.0.1:3000  (call the app locally)
#           CRON_SECRET    same value as the app's CRON_SECRET
#           HC_PING_BASE   default https://hc-ping.com
# ─────────────────────────────────────────────────────────────────────────────
set -eu

path="${1:?usage: pawasave-cron.sh <path> [hc_uuid]}"
hc="${2:-}"
: "${BASE_URL:?BASE_URL not set}"
: "${CRON_SECRET:?CRON_SECRET not set}"
HC_PING_BASE="${HC_PING_BASE:-https://hc-ping.com}"

ping() { [ -n "$hc" ] && curl -fsS -m 10 "$HC_PING_BASE/$hc$1" >/dev/null 2>&1 || true; }

# signal "run started" (lets healthchecks measure duration + detect hangs)
ping "/start"

out="$(mktemp)"
code="$(curl -sS -m 120 -o "$out" -w '%{http_code}' \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$BASE_URL$path" 2>>"$out" || echo 000)"

if [ "$code" = "200" ]; then
  ping ""                                   # success ping
  rm -f "$out"
  exit 0
fi

# failure: send the response body to healthchecks/fail so the alert has context
curl -fsS -m 10 --data-binary @"$out" "$HC_PING_BASE/$hc/fail" >/dev/null 2>&1 || true
echo "[pawasave-cron] $path FAILED http=$code" >&2
cat "$out" >&2 || true
rm -f "$out"
exit 1
