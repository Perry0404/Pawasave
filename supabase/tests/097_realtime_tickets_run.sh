#!/usr/bin/env bash
# Applies 097 to a throwaway postgres and runs its assertions.
#
# Standalone: 097 depends only on `profiles`, which the behaviour file stubs, so this does not need
# 094 to 096 applied first.
#
# Usage: bash supabase/tests/097_realtime_tickets_run.sh
set -euo pipefail

PORT=55439
NAME=pawa-097-test
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
  -f supabase/tests/097_realtime_tickets_behaviour.sql
