#!/usr/bin/env bash
# Applies every migration into a throwaway local Postgres and reports which ones fail.
#
# This is the only check that the migration chain is coherent, and it is how the missing
# 046-055 / 057-061 were found: the chain references columns that no committed migration
# creates, so 001..head does not build the production schema. See migrations 101 and 102.
#
# Needs a local Postgres you can createdb against. Nothing here touches staging or production.
#
#   ./supabase/tests/rebuild-from-scratch.sh            # just the chain
#   ./supabase/tests/rebuild-from-scratch.sh --keep     # leave the database for poking at
#   ./supabase/tests/rebuild-from-scratch.sh --seed     # plus seed users and the behaviour tests
#
# The behaviour tests come in two families and must not share a database.
#
#   Chain tests (079, 080, 099) run against the built schema after seed-staging-users.sql, and
#   simulate a session with `set local role authenticated` + `request.jwt.claims`.
#
#   Standalone tests (092-097) create their own tables and their own auth.uid() reading
#   `test.uid`. Sharing a database means whichever ran last decides what auth.uid() means, which
#   silently breaks every session check in the other family. Each gets a fresh empty database.
#
# The marker is `create or replace function auth.uid()`: a file that defines its own is
# standalone by definition.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

DB=pawa_rebuild_check
KEEP=0
SEED=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --seed) SEED=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# Supabase gives us these; a bare Postgres does not. auth.users needs `phone` because
# handle_new_user reads it.
scaffold() {
  psql -q -d "$1" >/dev/null 2>&1 <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon')           then create role anon;           end if;
  if not exists (select 1 from pg_roles where rolname='authenticated')  then create role authenticated;  end if;
  if not exists (select 1 from pg_roles where rolname='service_role')   then create role service_role;   end if;
  if not exists (select 1 from pg_roles where rolname='supabase_admin') then create role supabase_admin; end if;
end $$;

-- service_role BYPASSES RLS on Supabase, and a plain `create role` does not.
--
-- Without this a behaviour test running `set local role service_role` cannot read esusu_groups, so a
-- group id looked up inside the role block comes back NULL and the function under test answers
-- "circle not found". That is a harness artefact that reads exactly like a real bug, and it cost an
-- afternoon once. Every backend route uses the service key precisely because it bypasses RLS.
alter role service_role   bypassrls;
alter role supabase_admin bypassrls;
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(), email text, phone text,
  encrypted_password text, email_confirmed_at timestamptz, raw_user_meta_data jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  aud text, role text, instance_id uuid, confirmation_token text, recovery_token text
);
-- nullif BEFORE the cast, not after.
--
-- `current_setting('request.jwt.claims', true)` returns an empty string, not null, when the setting
-- has never been set in this transaction — and `''::jsonb` raises "invalid input syntax for type
-- json". Any statement that reaches auth.uid() or auth.role() outside a simulated session then fails
-- for a reason that has nothing to do with what is under test. It cost a wrong diagnosis once: the
-- savings_goals insert trigger calls auth.role(), so a plain superuser insert blew up and looked like
-- a broken migration. Supabase's own helpers tolerate this.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub','')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role','')::text $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
SQL

  # Supabase's permissive default, for the chain database only.
  #
  # The migrations assume it: 080 and 082 spend their whole effort REVOKING from anon and
  # authenticated, which only means anything against a baseline where everything was granted.
  # Without it 080_legitimate_flows fails on "permission denied for table wallets" and reads like
  # a hardening bug rather than a missing baseline.
  #
  # The standalone tests must NOT get it. They create their own tables and assert the grants they
  # then set — 092 checks that authenticated is read-only on push_devices, 094 that a client
  # cannot UPDATE a message — and a blanket `grant all` makes both pass for the wrong reason, or
  # fail. So they get roles and auth.uid() and nothing else.
  if [ "${2:-0}" = 1 ]; then
    psql -q -d "$1" >/dev/null 2>&1 <<'SQL'
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
SQL
  fi
}

dropdb --if-exists "$DB" 2>/dev/null
createdb "$DB" || { echo "could not create $DB" >&2; exit 1; }
scaffold "$DB" 1

# Two migrations have to run out of numeric order, because they record columns that were added
# to production by hand and that earlier migrations already depend on. Both say so in their
# headers. This is the ordering the chain actually needs, not a workaround.
declare -A OUT_OF_ORDER=(
  [001_initial.sql]=101_transactions_metadata.sql
  [041_strails_accounts.sql]=102_profiles_kyc_tier.sql
)

fails=0
count=0
for f in $(ls supabase/migrations/*.sql | sort -V); do
  base=$(basename "$f")
  case "$base" in 101_transactions_metadata.sql|102_profiles_kyc_tier.sql) continue ;; esac

  err=$(psql -q -d "$DB" -f "$f" 2>&1 | grep -E '^psql.*ERROR' | head -3)
  count=$((count + 1))
  if [ -n "$err" ]; then
    fails=$((fails + 1))
    printf '\n\033[31mFAIL\033[0m %s\n%s\n' "$base" "$err"
  fi

  early=${OUT_OF_ORDER[$base]:-}
  if [ -n "$early" ]; then
    err=$(psql -q -d "$DB" -f "supabase/migrations/$early" 2>&1 | grep -E '^psql.*ERROR' | head -3)
    count=$((count + 1))
    [ -n "$err" ] && { fails=$((fails + 1)); printf '\n\033[31mFAIL\033[0m %s (out of order, after %s)\n%s\n' "$early" "$base" "$err"; }
  fi
done

printf '\n%s migrations applied, %s failed\n' "$count" "$fails"

if [ "$SEED" = 1 ] && [ "$fails" = 0 ]; then
  err=$(psql -q -d "$DB" -f supabase/tests/seed-staging-users.sql 2>&1 | grep -E '^psql.*ERROR' | head -5)
  [ -n "$err" ] && printf '\n\033[31mseed failed\033[0m\n%s\n' "$err"

  for t in supabase/tests/*_behaviour.sql supabase/tests/080_legitimate_flows.sql; do
    [ -f "$t" ] || continue
    name=$(basename "$t")
    if grep -q 'create or replace function auth.uid()' "$t"; then
      # Standalone: its own empty database, because it redefines auth.uid().
      scratch="${DB}_$(echo "$name" | tr -cd '0-9_' | cut -c1-20)"
      dropdb --if-exists "$scratch" 2>/dev/null
      createdb "$scratch" && scaffold "$scratch"
      printf '\n── %s (standalone)\n' "$name"
      psql -d "$scratch" -f "$t" 2>&1 | grep -E 'PASS|FAIL|ASSERTIONS'
      [ "$KEEP" = 1 ] || dropdb --if-exists "$scratch"
    else
      printf '\n── %s\n' "$name"
      psql -d "$DB" -f "$t" 2>&1 | grep -E 'PASS|FAIL|ASSERTIONS'
    fi
  done
fi

if [ "$KEEP" = 1 ]; then
  echo
  echo "kept: psql -d $DB"
else
  dropdb --if-exists "$DB"
fi

[ "$fails" = 0 ] || exit 1
