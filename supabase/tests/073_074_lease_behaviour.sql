-- Behaviour checks for the custody lease. These are the properties custody-lease.ts
-- relies on, so if any of these fail the TypeScript guarantees are void.

create temp table results (ord int, name text, detail text, ok boolean);

-- A second acquire on a held key must be refused.
with a as (select public.try_acquire_lease('t:excl', 60, 'first') as t1),
     b as (select public.try_acquire_lease('t:excl', 60, 'second') as t2 from a)
insert into results
select 1, 'second acquire refused while held',
       case when b.t2 is null then 'second got null' else 'second got a token' end,
       a.t1 is not null and b.t2 is null
from a, b;

-- Releasing with someone else's token must not free the key. This is the fencing
-- property the old release_lock lacked.
insert into results
select 2, 'release with a foreign token refused', 'returned ' || r::text, r = false
from (select public.release_lease('t:excl', gen_random_uuid()) as r) s;

insert into results
select 3, 'holder can release', 'returned ' || r::text, r = true
from (select public.release_lease('t:excl', (select token from public.system_locks where key = 't:excl')) as r) s;

insert into results
select 4, 'key reusable after release',
       case when t is null then 'got null' else 'got a token' end, t is not null
from (select public.try_acquire_lease('t:excl', 60, 'third') as t) s;

-- An expired lease must be stealable or a crashed holder wedges the key forever.
select public.release_lease('t:excl', (select token from public.system_locks where key = 't:excl'));
select public.try_acquire_lease('t:expiry', 1, 'crashed-holder');
select pg_sleep(1.3);
insert into results
select 5, 'expired lease can be stolen',
       case when t is null then 'still blocked' else 'stolen' end, t is not null
from (select public.try_acquire_lease('t:expiry', 60, 'next-run') as t) s;

insert into results
select 6, 'refresh works for the holder', 'returned ' || r::text, r = true
from (select public.refresh_lease('t:expiry', (select token from public.system_locks where key = 't:expiry'), 120) as r) s;

insert into results
select 7, 'refresh refused for a foreign token', 'returned ' || r::text, r = false
from (select public.refresh_lease('t:expiry', gen_random_uuid(), 120) as r) s;

-- A lost lease must not be resurrectable.
insert into results
select 8, 'refresh on an unheld key refused', 'returned ' || r::text, r = false
from (select public.refresh_lease('t:never', gen_random_uuid(), 120) as r) s;

insert into public.equity_sales (user_id, symbol, provider, shares, status, usdc_micro)
values ('11111111-1111-1111-1111-111111111111', 'TSLA', 'base_dex', 0.5, 'settling', 1225700);

-- LATERAL forces the second bump to run after the first.
insert into results
select 9, 'attempt counter increments',
       'first ' || x.a::text || ', second ' || y.b::text, x.a = 1 and y.b = 2
from (select public.bump_equity_sell_attempt((select min(id) from public.equity_sales), 'no solver') as a) x
cross join lateral (select public.bump_equity_sell_attempt((select min(id) from public.equity_sales), 'still none') as b) y;

insert into results
select 10, 'view excludes sales under the cap', count(*)::text || ' rows', count(*) = 0
from public.equity_sales_needing_attention;

update public.equity_sales set settle_attempts = 12;
insert into results
select 11, 'view includes sales at the cap', count(*)::text || ' rows', count(*) = 1
from public.equity_sales_needing_attention;

select case when ok then 'PASS' else 'FAIL' end as result, name, detail
from results order by ord;

select count(*) filter (where not ok) as failures from results;
