#!/usr/bin/env bash
# Proves CAPTURE-prod-posture.sql round-trips. Builds a source database with a deliberately
# mixed posture, captures it, replays onto a second database with the same schema but no
# posture, then compares.
#
# Fidelity has to hold in both directions. Staging ending up MORE locked down than production
# is the failure that makes the adversarial exercise worthless, so the comparison must catch a
# difference either way, not just a missing grant.
#
# Usage: bash supabase/tests/capture-replay-harness.sh
set -euo pipefail

CAP=.kiro/specs/week1-critical-remediation/CAPTURE-prod-posture.sql
PORT=55434
NAME=pawa-capture-test
export PGPASSWORD=check

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -f "$REPLAY" 2>/dev/null || true; }
trap cleanup EXIT

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=check -p ${PORT}:5432 postgres:15-alpine >/dev/null
for _ in $(seq 1 60); do
  psql -h 127.0.0.1 -p $PORT -U postgres -c "select 1" >/dev/null 2>&1 && break
  sleep 1
done

pg() { psql -h 127.0.0.1 -p $PORT -U postgres -q -v ON_ERROR_STOP=1 "$@"; }

pg -c "create database src" >/dev/null
pg -c "create database dst" >/dev/null
pg -c "do \$\$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I', r); end if;
  end loop; end \$\$;" >/dev/null

# Stands in for pg_dump --schema-only --no-privileges: same structure in both, no posture.
read -r -d '' SCHEMA <<'SQL' || true
create function public.auth_uid_stub() returns uuid language sql as $$ select null::uuid $$;
create table public.wallets (id bigserial primary key, user_id uuid unique, balance bigint default 0);
create table public.profiles (id uuid primary key, kyc_status text);
create table public.rates (id int primary key, apy numeric);
create table public.revenue_journal (id int primary key, amount bigint);
create view public.rates_v as select id, apy from public.rates;
create function public.client_ok(p_user_id uuid) returns boolean language sql security definer as $$ select true $$;
create function public.service_only(p_user_id uuid, amt bigint) returns boolean language sql security definer as $$ select true $$;
create function public.overloaded(a int) returns int language sql as $$ select 1 $$;
create function public.overloaded(a int, b int) returns int language sql as $$ select 2 $$;
SQL

for db in src dst; do
  psql -h 127.0.0.1 -p $PORT -U postgres -d $db -q -v ON_ERROR_STOP=1 -c "$SCHEMA" >/dev/null
done

# Mixed posture on src only. RLS on two tables and off two, policies across different
# commands and role sets, one function client-reachable and one locked to service_role,
# and an overloaded function so signature handling is exercised.
psql -h 127.0.0.1 -p $PORT -U postgres -d src -q -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
alter table public.wallets  enable row level security;
alter table public.profiles enable row level security;
create policy wallets_owner_read on public.wallets  as permissive for select to authenticated using (public.auth_uid_stub() = user_id);
create policy wallets_no_write   on public.wallets  as restrictive for update to authenticated using (false);
create policy profiles_owner_all on public.profiles as permissive for all    to authenticated using (true) with check (true);
create policy rates_public_read  on public.rates    as permissive for select to anon, authenticated using (true);
grant select on public.rates   to anon, authenticated;
grant select on public.rates_v to anon;
grant select, insert on public.wallets to authenticated;
revoke all on function public.service_only(uuid, bigint) from public, anon, authenticated;
grant execute on function public.service_only(uuid, bigint) to service_role;
SQL

echo "=== generating replay SQL from src ==="
REPLAY=$(mktemp)
psql -h 127.0.0.1 -p $PORT -U postgres -d src -At -v ON_ERROR_STOP=1 -f "$CAP" > "$REPLAY"
echo "$(grep -cE '^(alter|create|drop|grant|revoke)' "$REPLAY") statements generated"

echo "=== replaying onto dst ==="
if ! psql -h 127.0.0.1 -p $PORT -U postgres -d dst -q -v ON_ERROR_STOP=1 -f "$REPLAY" >/dev/null 2>/tmp/replay.err; then
  echo "replay failed:"; head -8 /tmp/replay.err; exit 1
fi
echo "replay applied cleanly"

echo "=== comparing ==="
read -r -d '' SUMQ <<'SQL' || true
select
 (select count(*) from pg_tables where schemaname='public' and rowsecurity) rls_on,
 (select count(*) from pg_policies where schemaname='public') policies,
 (select coalesce(string_agg(policyname||':'||cmd||':'||array_to_string(roles,'+'), ',' order by policyname),'-')
    from pg_policies where schemaname='public') policy_detail,
 (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prokind='f' and has_function_privilege('anon',p.oid,'execute')) fn_anon,
 (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prokind='f' and has_function_privilege('authenticated',p.oid,'execute')) fn_auth,
 (select coalesce(string_agg(c.relname, ',' order by c.relname),'-') from pg_class c
   join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
   and c.relkind in ('r','v') and has_table_privilege('anon',c.oid,'SELECT')) anon_readable
SQL

A=$(psql -h 127.0.0.1 -p $PORT -U postgres -d src -At -c "$SUMQ")
B=$(psql -h 127.0.0.1 -p $PORT -U postgres -d dst -At -c "$SUMQ")
echo "src: $A"
echo "dst: $B"
if [ "$A" = "$B" ]; then
  echo
  echo "MATCH: staging would mirror production exactly"
else
  echo
  echo "DIFFERENT: capture does not round-trip, do not trust it"
  exit 1
fi
