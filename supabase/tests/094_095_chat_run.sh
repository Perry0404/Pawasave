#!/usr/bin/env bash
# Applies 094 and 095 to a throwaway postgres and runs their assertions.
#
# Both together, because 095's functions reference 094's tables and its REVOKE/GRANT lines name exact
# signatures. A signature typo would otherwise only surface in production, where these are pasted in
# by hand.
#
# Usage: bash supabase/tests/094_095_chat_run.sh
set -euo pipefail

PORT=55437
NAME=pawa-094-test
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
  -f supabase/tests/094_095_chat_behaviour.sql
