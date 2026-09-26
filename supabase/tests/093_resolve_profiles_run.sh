#!/usr/bin/env bash
# Applies 092 then 093 to a throwaway postgres and runs 093's assertions.
#
# 093 ALTERs functions that 092 creates, so both are applied in order, which also proves the
# ALTER targets match 092's real signatures. A typo there would otherwise only surface in
# production, where the migration is pasted in by hand.
#
# Usage: bash supabase/tests/093_resolve_profiles_run.sh
set -euo pipefail

PORT=55436
NAME=pawa-093-test
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
  -f supabase/tests/093_resolve_profiles_behaviour.sql
