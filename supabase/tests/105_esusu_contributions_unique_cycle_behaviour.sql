-- 105_esusu_contributions_unique_cycle_behaviour.sql
--
-- STAGING ONLY. Proves the constraint stops a double-recorded rotating contribution and still lets a
-- collection circle contribute repeatedly, which is what a collection is.
--
-- Depends on seed-staging-users.sql.

create temp table if not exists r (ord int, name text, detail text, ok boolean);
delete from r;

-- A rotating circle and a collection circle, each with one member.
do $$
declare v_rot uuid; v_col uuid;
begin
  delete from public.esusu_groups where name in ('Unique test rotating', 'Unique test collection');

  insert into public.esusu_groups
    (name, owner_id, contribution_amount_kobo, cycle_period, max_members, status,
     circle_type, payout_mode, current_cycle)
  values ('Unique test rotating', '00000000-0000-4000-8000-000000000001', 500000, 'monthly', 4,
          'active', 'rotating_ajo', 'rotating', 2)
  returning id into v_rot;
  insert into public.esusu_members (group_id, user_id, payout_position)
  values (v_rot, '00000000-0000-4000-8000-000000000001', 1);

  insert into public.esusu_groups
    (name, owner_id, contribution_amount_kobo, cycle_period, max_members, status,
     circle_type, payout_mode, current_cycle)
  values ('Unique test collection', '00000000-0000-4000-8000-000000000001', 0, 'monthly', 10,
          'active', 'aso_ebi', 'collection', 0)
  returning id into v_col;
  insert into public.esusu_members (group_id, user_id, payout_position)
  values (v_col, '00000000-0000-4000-8000-000000000001', 1);
end $$;

-- 1. The index exists and is partial on the rotating cycles.
do $$
declare v_def text;
begin
  select indexdef into v_def from pg_indexes
   where schemaname = 'public' and indexname = 'esusu_contributions_one_per_cycle';
  insert into r values (1, 'the index exists and is partial', coalesce(v_def, '(missing)'),
    v_def is not null and v_def like '%cycle_number > 0%'
      and v_def like '%group_id%' and v_def like '%member_id%');
end $$;

-- 2. A second contribution for the same member and rotating cycle is refused.
do $$
declare v_rot uuid; v_member uuid; msg text; v_rows int;
begin
  select id into v_rot from public.esusu_groups where name = 'Unique test rotating';
  select id into v_member from public.esusu_members where group_id = v_rot limit 1;

  insert into public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
  values (v_rot, v_member, 2, 497500);

  begin
    insert into public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
    values (v_rot, v_member, 2, 497500);
    msg := 'NO ERROR';
  exception when unique_violation then msg := 'refused';
            when others then msg := SQLERRM;
  end;

  select count(*) into v_rows from public.esusu_contributions
   where group_id = v_rot and member_id = v_member and cycle_number = 2;

  insert into r values (2, 'a second row for the same cycle is refused',
    msg || ', rows now ' || v_rows, msg = 'refused' and v_rows = 1);
end $$;

-- 3. The next cycle is a different row, so the rotation still works.
do $$
declare v_rot uuid; v_member uuid; v_rows int;
begin
  select id into v_rot from public.esusu_groups where name = 'Unique test rotating';
  select id into v_member from public.esusu_members where group_id = v_rot limit 1;

  insert into public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
  values (v_rot, v_member, 3, 497500);

  select count(*) into v_rows from public.esusu_contributions
   where group_id = v_rot and member_id = v_member;
  insert into r values (3, 'the next cycle is unaffected', 'rows across cycles ' || v_rows,
    v_rows = 2);
exception when others then
  insert into r values (3, 'the next cycle is unaffected', 'failed: ' || SQLERRM, false);
end $$;

-- 4. A collection circle contributes as many times as it likes. This is why the index is partial: an
--    aso ebi, event dues, harambee or group buy is many payments into one pot, all at cycle 0.
do $$
declare v_col uuid; v_member uuid; v_rows int;
begin
  select id into v_col from public.esusu_groups where name = 'Unique test collection';
  select id into v_member from public.esusu_members where group_id = v_col limit 1;

  insert into public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
  values (v_col, v_member, 0, 100000),
         (v_col, v_member, 0, 250000),
         (v_col, v_member, 0,  50000);

  select count(*) into v_rows from public.esusu_contributions
   where group_id = v_col and member_id = v_member and cycle_number = 0;
  insert into r values (4, 'a collection circle still contributes repeatedly',
    'rows at cycle 0: ' || v_rows, v_rows = 3);
exception when others then
  insert into r values (4, 'a collection circle still contributes repeatedly',
    'failed: ' || SQLERRM, false);
end $$;

-- 5. Two different members in the same cycle are fine, which is the normal case.
do $$
declare v_rot uuid; v_second uuid; v_rows int;
begin
  select id into v_rot from public.esusu_groups where name = 'Unique test rotating';
  insert into public.esusu_members (group_id, user_id, payout_position)
  values (v_rot, '00000000-0000-4000-8000-000000000002', 2)
  returning id into v_second;

  insert into public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
  values (v_rot, v_second, 2, 497500);

  select count(*) into v_rows from public.esusu_contributions
   where group_id = v_rot and cycle_number = 2;
  insert into r values (5, 'two members in one cycle are fine', 'rows in cycle 2: ' || v_rows,
    v_rows = 2);
exception when others then
  insert into r values (5, 'two members in one cycle are fine', 'failed: ' || SQLERRM, false);
end $$;

select ord, name, detail, case when ok then 'PASS' else 'FAIL' end as result
from r order by ord;
