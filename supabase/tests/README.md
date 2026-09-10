# SQL tests

Migrations here are applied by hand, so these run against a throwaway Postgres rather than
a live project. Nothing here touches staging or production.

```bash
docker run -d --name pawa-sqlcheck -e POSTGRES_PASSWORD=check -p 55433:5432 postgres:15-alpine
export PGPASSWORD=check
psql -h 127.0.0.1 -p 55433 -U postgres -c "create database m"

psql -h 127.0.0.1 -p 55433 -U postgres -d m -v ON_ERROR_STOP=1 -f supabase/tests/fixture-minimal.sql
psql -h 127.0.0.1 -p 55433 -U postgres -d m -v ON_ERROR_STOP=1 -f supabase/migrations/073_custody_lease.sql
psql -h 127.0.0.1 -p 55433 -U postgres -d m -v ON_ERROR_STOP=1 -f supabase/migrations/074_equity_sell_attempts.sql
psql -h 127.0.0.1 -p 55433 -U postgres -d m -v ON_ERROR_STOP=1 -f supabase/tests/073_074_lease_behaviour.sql

docker rm -f pawa-sqlcheck
```

The last query prints a `failures` count. It must be 0.

`fixture-minimal.sql` only creates what the migration under test touches, and it creates
`system_locks` without a unique key on `key` on purpose. Migration 054 that originally
created that table is not in this repo, so the production shape is unverified, and 073 has
to cope with the worst case.
