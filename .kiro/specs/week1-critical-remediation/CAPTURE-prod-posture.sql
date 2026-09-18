-- CAPTURE-prod-posture.sql
--
-- Read-only. Run on PRODUCTION. Emits executable SQL that replays production's RLS, policy
-- and grant posture onto staging.
--
-- Why this exists. The runbook's step 1.4 said to read the introspection output and
-- reproduce the posture by hand, and also said that step is the one most likely to go wrong.
-- It is right: if staging ends up more locked down than production, the adversarial tests
-- pass for the wrong reason and prove nothing. Generating the statements removes the
-- transcription from the loop.
--
-- pg_dump --no-privileges deliberately drops grants, so this is what puts them back, matching
-- production exactly rather than approximately.
--
-- How to use it. Each of the four queries returns one text cell. Copy each cell, not the
-- JSON wrapper, paste them into one file in order, and run that against staging AFTER the
-- schema dump is loaded.
--
-- This file contains only statement generators, no summary, so it can also be piped
-- straight through: psql -At -f CAPTURE-prod-posture.sql > replay.sql
--
-- Ordering matters: RLS before policies, because a policy on a table with RLS off is legal
-- but misleading, and grants last so nothing is granted on an object that does not exist yet.

-- ── Section 1: row level security per table ──────────────────────────────────
select
  '-- section 1: row level security' || chr(10) ||
  coalesce(string_agg(
    format('alter table %I.%I %s row level security;',
           schemaname, tablename,
           case when rowsecurity then 'enable' else 'disable' end),
    chr(10) order by tablename), '-- no tables')
  as section_1_rls
from pg_tables
where schemaname = 'public';

-- ── Section 2: policies, verbatim ────────────────────────────────────────────
-- Dropped first so a re-run is clean. pg_dump may have carried some policies across, and a
-- duplicate name would abort the load.
select
  '-- section 2: policies' || chr(10) ||
  coalesce(string_agg(
    format('drop policy if exists %I on %I.%I;', policyname, schemaname, tablename)
    || chr(10) ||
    format('create policy %I on %I.%I as %s for %s to %s%s%s;',
           policyname, schemaname, tablename,
           case when permissive = 'PERMISSIVE' then 'permissive' else 'restrictive' end,
           lower(cmd),
           (select string_agg(quote_ident(r), ', ') from unnest(roles) as r),
           case when qual       is not null then ' using (' || qual || ')' else '' end,
           case when with_check is not null then ' with check (' || with_check || ')' else '' end),
    chr(10) order by tablename, policyname), '-- no policies')
  as section_2_policies
from pg_policies
where schemaname = 'public';

-- ── Section 3: function execute grants ───────────────────────────────────────
-- Only anon and authenticated matter for fidelity. service_role and postgres are broad by
-- default in a fresh Supabase project, and PUBLIC is the default that got us here, so it is
-- reproduced explicitly rather than left to chance.
select
  '-- section 3: function execute grants' || chr(10) ||
  '-- start from a clean slate so staging cannot be MORE permissive than production' || chr(10) ||
  coalesce(string_agg(stmt, chr(10) order by fname, grantee), '-- none')
  as section_3_function_grants
from (
  select
    p.proname as fname,
    g.grantee,
    format('revoke all on function %s from %I;', p.oid::regprocedure, g.grantee)
    || case when has_function_privilege(g.grantee, p.oid, 'execute')
            then chr(10) || format('grant execute on function %s to %I;', p.oid::regprocedure, g.grantee)
            else '' end as stmt
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated'), ('public')) as g(grantee)
  where n.nspname = 'public' and p.prokind in ('f', 'p')
) s;

-- ── Section 4: table and view grants ────────────────────────────────────────
select
  '-- section 4: table and view grants' || chr(10) ||
  coalesce(string_agg(stmt, chr(10) order by tname, grantee, priv), '-- none')
  as section_4_table_grants
from (
  select
    c.relname as tname,
    g.grantee,
    pr.priv,
    case when has_table_privilege(g.grantee, c.oid, pr.priv)
         then format('grant %s on %I.%I to %I;', pr.priv, n.nspname, c.relname, g.grantee)
         else format('revoke %s on %I.%I from %I;', pr.priv, n.nspname, c.relname, g.grantee)
    end as stmt
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated')) as g(grantee)
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as pr(priv)
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
) s;
