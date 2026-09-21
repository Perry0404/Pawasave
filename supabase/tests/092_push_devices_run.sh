#!/usr/bin/env bash
# Applies 092_push_devices.sql to a throwaway postgres and runs its behaviour assertions.
#
# Same shape as capture-replay-harness.sh: a disposable container, no connection to any real
# project. Nothing here can touch production, which is the point, because the migration is applied
# by hand against Supabase and this is the only place it can be exercised first.
#
# Usage: bash supabase/tests/092_push_devices_run.sh
set -euo pipefail

PORT=55435
NAME=pawa-092-test
export PGPASSWORD=check

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=check -p ${PORT}:5432 postgres:15-alpine >/dev/null

for _ in $(seq 1 60); do
  psql -h 127.0.0.1 -p $PORT -U postgres -c "select 1" >/dev/null 2>&1 && break
  sleep 1
done

# ON_ERROR_STOP so a failed assertion fails the script rather than scrolling past.
psql -h 127.0.0.1 -p $PORT -U postgres \
  -v ON_ERROR_STOP=1 \
  -f supabase/tests/092_push_devices_behaviour.sql
