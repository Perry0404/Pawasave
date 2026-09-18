# Staging setup runbook

Tasks 11 and 12. Everything in Phase 5 depends on this, and so does the authorization
migration in task 21.

## Why this is not optional

Seven of the nine adversarial test cases are pure database behaviour: can a client write
its own balance, call a credit function directly, read the revenue views. Those cannot be
tested anywhere except a real Postgres with real RLS.

More pointedly, I have produced four query bugs across six read-only files today. Two of
them returned plausible wrong answers rather than errors, which is the dangerous kind. The
authorization migration drops policies and revokes execute grants across the schema. Typing
that straight into production at the same hit rate is not acceptable, and a transaction
wrapper only protects against partial application, not against the statement being wrong.

## One dependency that turned out not to exist

Task 21.6 pins `search_path` on the 79 SECURITY DEFINER functions that lack it, and the plan
assumed that meant recreating each one from source, which would have needed the eight
functions whose definitions are missing from the repo, which needed the schema dump.

It does not. `ALTER FUNCTION ... SET search_path` attaches the setting without touching the
body, verified on Postgres 15: `proconfig` is set and `pg_get_functiondef` returns the
original body unchanged. `GENERATE-search-path-fix.sql` emits the statements, schema-qualified,
one per overload.

So 21.6 is off the staging critical path. Rehearse it on staging anyway, but it is no longer
blocked on recovering source.

## The important decision: staging schema comes from production, not from the repo

Do not build staging by running the 72 migration files. We already know the repo diverges
from production in both directions:

- RLS was **disabled** on `wallets` and `profiles` in production while every migration says
  to enable it
- `rls_auto_enable` exists in the database and in no migration
- eight functions run in production with no source in the repo
- three files are numbered `007`, two are numbered `017`, and 046 to 061 are missing

A staging database built from migrations would be a different database from the one we are
trying to protect, and would give false confidence.

**Clone production's schema instead.** Structure only, no customer rows.

---

## Part 1: staging Supabase

### 1.1 Reset the production database password

You avoided this earlier, sensibly. Re-verified 09 Sep against production itself, not just
the repo:

- production has 58 environment variables configured in Coolify and **not one is a Postgres
  connection string**. No `DATABASE_URL`, no `POSTGRES_URL`, no `PGHOST`
- no Postgres wire-protocol driver in `frontend/package.json`, and no `postgresql://` or
  `postgres://` anywhere in `frontend/src`
- the app reaches Supabase only through `NEXT_PUBLIC_SUPABASE_URL` with the anon and
  service-role JWTs, which is PostgREST over HTTP

The decisive point: **resetting the database password does not rotate those JWTs.** They are
separate credentials. So the reset cannot affect the running app.

Dashboard → **Settings → Database → Reset database password**. Store it in your password
manager, not in the repo.

## Connecting to either project, which is not obvious

Both projects' direct hosts (`db.<ref>.supabase.co`) resolve to **IPv6 only**, and this
machine has no IPv6 route, so `pg_dump` and `psql` cannot use them. Use the session pooler on
port 5432. The transaction pooler on 6543 will not work for `pg_dump`.

Two things cost time and are worth writing down:

- the two projects sit on **different pooler generations**. Production answers on `aws-0-`,
  staging on `aws-1-`. Using the wrong generation returns
  `(ENOTFOUND) tenant/user postgres.<ref> not found`, which reads like a bad credential
- a wrong-region pooler **hangs instead of erroring**, so `psql` just times out and tells you
  nothing. `pgprobe.py` in this folder completes the TLS handshake and sends a real
  StartupMessage so the server's actual message comes back. That is how the region and
  generation above were found

```
prod     postgresql://postgres.rdamvdxevhjpcfrevvxk:<PW>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require
staging  postgresql://postgres.jygewqsyohmisiituhzc:<PW>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require
```

Set a generous `PGCONNECT_TIMEOUT`, 25 or so. DNS for the pooler hosts resolves
intermittently from here, so use `pq.sh` in this folder rather than bare `psql` for anything
that compares the two databases. A transient DNS failure returns nothing, and nothing looks
exactly like an empty result: the first per-object diff reported 141 differences purely because
the staging half of it never ran. `pq.sh` retries transient failures, passes real SQL errors
straight through, and exits 99 if it never got an answer, so a caller can tell "no rows" from
"could not ask".

### Versions match after all

Both are on **Postgres 17.6**, so the mismatch I expected here does not exist. Production had
been assumed to be on 15.x; it is not.

### 1.2 Create the staging project

Dashboard → **New project**, name it `pawasave-staging`, same region as production so
latency behaves similarly. Free tier is fine. Note its own database password at creation.

### 1.3 Copy the schema across

```sh
# structure only, no data
pg_dump \
  "postgresql://postgres:<PROD_PASSWORD>@db.rdamvdxevhjpcfrevvxk.supabase.co:5432/postgres" \
  --schema-only --no-owner --no-privileges \
  --schema=public \
  -f prod-schema.sql

# review before loading, this is also the artefact task 2 needs
less prod-schema.sql

psql "postgresql://postgres:<STAGING_PASSWORD>@db.<staging-ref>.supabase.co:5432/postgres" \
  -f prod-schema.sql
```

Two notes. `--no-privileges` drops the grants, which we then re-apply deliberately in
step 1.4 so staging starts from a known grant state rather than an inherited one. And
`--schema=public` skips `auth`, `storage` and `realtime`, which Supabase manages itself and
which will already exist in the new project.

### 1.3a The one thing the dump silently leaves behind

`--schema=public` cannot carry a trigger that lives on a table in another schema, and there is
exactly one that matters:

```sql
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
```

`handle_new_user` itself is in `public` so it dumps fine. The trigger that fires it is on
`auth.users` and does not. Without it a signup on staging creates an auth row and no profile or
wallet, so every seeded user is hollow and the adversarial tests exercise the wrong thing.
Recreate it after loading, then confirm both databases report the same non-platform triggers:

```sql
select n.nspname||'.'||c.relname||' -> '||t.tgname
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where not t.tgisinternal and n.nspname in ('public', 'auth')
order by 1;
```

Expect exactly `auth.users -> on_auth_user_created` and
`public.profiles -> trg_protect_transaction_pin`. Everything else under `storage` and
`realtime` is Supabase's and arrives with the project.

### 1.3b rls_auto_enable is Supabase's, not ours

Loading the dump reports `function "rls_auto_enable" already exists`. That is because it is
already there in a brand new, empty project. The audit had it listed as a function present in
the database and in no migration, implying someone added it. It is a platform function that
ships with every Supabase project, so it needs no explanation and no migration.

Keep `prod-schema.sql` outside the repo. It is structural detail we do not want committed.

### 1.4 Reproduce the production grant and RLS state

**Superseded 09 Sep. Do not do this by hand.** The original instruction was to read the
introspection output and retype the posture, and it also said this was the step most likely
to go wrong. It was, and it has since become wrong in a second way: it told you to grant
execute to anon and authenticated on whatever was reachable, and migrations 077 and 078
have since revoked most of that. Following it now would rebuild the hole in staging.

Use `CAPTURE-prod-posture.sql` instead. Run it on production, and it emits the statements:

```sh
# on production, four text cells, or pipe it straight through
psql "$PROD_URL" -At -f .kiro/specs/week1-critical-remediation/CAPTURE-prod-posture.sql > replay.sql

# review, then apply to staging AFTER the schema dump is loaded
psql "$STAGING_URL" -f replay.sql
```

It reproduces RLS per table, every policy verbatim including restrictive ones, function
execute grants for anon, authenticated and PUBLIC, and table and view grants. It revokes
before granting, so staging cannot end up **more** permissive than production either.

Round-trip proven by `supabase/tests/capture-replay-harness.sh`, which builds a source
database with a mixed posture, captures it, replays onto an empty one and compares RLS
counts, policy names with their commands and roles, function grant counts and the set of
anon-readable relations. It exits non-zero on any difference.

Then confirm with `VERIFY-posture-summary.sql`, run on both and compared. Every number must
match. If staging is more locked down than production the adversarial suite passes for the
wrong reason and tells us nothing.

### 1.5 Seed test users

Create four or five users through the normal signup flow so the `handle_new_user` trigger
builds their rows properly, rather than inserting directly. Then give them state to attack:

- one with a spendable balance
- one with an active savings lock
- one with an equity holding and a filled order
- one with a savings goal
- one with no KYC, one BVN-only, one `kyc_status='verified'`, so the withdrawal tiers are
  all exercised

### 1.6 Keys

From the staging project settings, note its URL, anon key and service-role key. These are
what the staging app uses. They are unrelated to production's.

---

## Part 2: staging app

Railway is fine and fast, and it builds the same `frontend/Dockerfile` as production, so
runtime fidelity is good. A second Coolify application would be marginally closer but the
box is a 2 vCPU / 4 GB CX22 already running production plus Coolify itself.

Treat this as scaffolding for this engagement. Build real staging on Contabo when
production moves.

### 2.1 Create the service

Railway → **New Project → Deploy from GitHub repo**, pick the Pawasave repo.

- **Root directory**: `frontend`
- **Branch**: `audit-v2-remediation-and-flint-onramp`, not `main`
- Railway detects the Dockerfile automatically

### 2.2 Environment

The `NEXT_PUBLIC_*` values are baked into the client bundle at **build** time, so they must
be set before the first build, not after.

```
NEXT_PUBLIC_SUPABASE_URL=https://<staging-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<staging anon key>
NEXT_PUBLIC_BASE_RPC_URL=<your Base RPC>
NEXT_PUBLIC_SITE_URL=<railway url>

SUPABASE_SERVICE_ROLE_KEY=<staging service role key>
CRON_SECRET=<fresh random value, not production's>
ADMIN_PASSWORD=<fresh value>
ADMIN_SESSION_SECRET=<fresh value, distinct from ADMIN_PASSWORD>
```

### 2.3 Keep money off

Everything that moves real value stays off in staging:

```
EQUITY_ENABLED=false
HYPERFX_ENABLED=false
STRAILS_ENABLED=false
GETEQUITY_ENABLED=
FLINT_ENABLED=false
XEND_ENABLED=false
USSD_ENABLED=false
```

Note `GETEQUITY_ENABLED` must be **empty**, not `false`. It is read as
`!!process.env.GETEQUITY_ENABLED`, so the string `"false"` is truthy and would turn it on.
That footgun is `P3-H-08` in the audit's flag table.

### 2.4 Custody key

Generate a **fresh throwaway private key** and fund it with nothing.

```sh
node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"
```

Never put the production `CUSTODY_PRIVATE_KEY` in staging. If a staging code path signs
something unexpected, it must not be able to move real funds.

### 2.5 No crons

Do not install the crontab against staging. The reconcilers would attempt real chain work
with a key that holds nothing, producing noise. Trigger the cron routes by hand with curl
and the staging `CRON_SECRET` when a test needs one.

---

## Part 3: verify staging is actually representative

Before trusting it, confirm it reproduces production's posture. Run
`phase0-introspection.sql` against staging and diff section by section against the
production run.

Section 1 should match production almost exactly, in particular:

- the same set of tables without RLS
- the same count of functions reachable by anon or authenticated
- the same six views lacking `security_invoker`

**If staging is more locked down than production, the adversarial suite will pass for the
wrong reason and tell us nothing.** That mismatch is the main failure mode of this whole
exercise, so it is worth the extra run to rule out.

## Done when

- Staging Supabase mirrors production's schema, RLS and grants
- Staging app builds from the same Dockerfile and serves
- Test users exist covering every withdrawal tier and product state
- `phase0-introspection.sql` on staging matches production section by section
- No real money, no real keys, no crons
