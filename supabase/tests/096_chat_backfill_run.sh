#!/usr/bin/env bash
# Applies 094, 095 and 096 to a throwaway postgres and runs 096's assertions.
#
# All three, because the backfill inserts directly into 094's tables and calls 095's room functions.
# It also applies 096 TWICE, to prove the migration is idempotent — these are pasted into production
# by hand and a re-run must be harmless.
#
# Usage: bash supabase/tests/096_chat_backfill_run.sh
set -euo pipefail

PORT=55438
NAME=pawa-096-test
export PGPASSWORD=check

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=check -p ${PORT}:5432 postgres:15-alpine >/dev/null

for _ in $(seq 1 60); do
  psql -h 127.0.0.1 -p $PORT -U postgres -c "select 1" >/dev/null 2>&1 && break
  sleep 1
done

psql -h 127.0.0.1 -p $PORT -U postgres \
  -v ON_ERROR_STOP=1 \
  -f supabase/tests/096_chat_backfill_behaviour.sql
