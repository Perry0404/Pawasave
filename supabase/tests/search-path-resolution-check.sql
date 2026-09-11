-- search-path-resolution-check.sql
--
-- STAGING ONLY. Read-only in effect: every call is made inside a subtransaction that is
-- rolled back.
--
-- The risk in pinning search_path. A SECURITY DEFINER function that referenced something in
-- another schema without qualifying it used to resolve through the caller's search_path, which
-- in Supabase includes `extensions`. Pinned to `public, pg_temp`, that reference stops
-- resolving and the function starts failing at runtime rather than at ALTER time. Nothing in
-- the ALTER tells you this: it succeeds and the breakage shows up later, in production, on a
-- money path.
--
-- So every function is invoked with all-NULL arguments and the error is classified. Business
-- errors are expected and fine. What matters is any error that names something as not
-- existing, because that is a resolution failure rather than a rejected input.

do $$
declare
  r record;
  call_sql text;
  arg_list text;
  errm text;
  errstate text;
  n_ok int := 0;
  n_business int := 0;
  n_resolution int := 0;
begin
  -- Not ON COMMIT DROP: psql commits after this block and the reporting queries below need
  -- the table to still be there.
  create temp table if not exists resolution_results (
    fname text, args text, sqlstate text, message text, verdict text
  );
  delete from resolution_results;

  for r in
    select p.oid,
           p.proname,
           pg_get_function_identity_arguments(p.oid) as ident_args,
           p.proargtypes::text as argtypes,
           t.typname as rettype
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type t on t.oid = p.prorettype
    where n.nspname = 'public'
      and p.prokind = 'f'
      and t.typname <> 'trigger'            -- a trigger function cannot be called directly
      and t.typname <> 'event_trigger'
    order by p.proname
  loop
    -- Build a call with the right number of NULLs, each cast to its declared type so an
    -- overloaded name still resolves to the intended signature.
    select coalesce(string_agg('null::' || format_type(tid::oid, null), ', ' order by ord), '')
      into arg_list
    from unnest(string_to_array(nullif(trim(r.argtypes), ''), ' ')) with ordinality as u(tid, ord);

    call_sql := format('select public.%I(%s)', r.proname, arg_list);

    begin
      execute call_sql;
      insert into resolution_results values (r.proname, r.ident_args, '00000', '', 'called cleanly');
      n_ok := n_ok + 1;
    exception when others then
      errm := sqlerrm;
      errstate := sqlstate;
      if errm ~* '(does not exist|could not (find|identify)|unknown function|no function matches)'
         and errm !~* 'function public\.' then
        insert into resolution_results values (r.proname, r.ident_args, errstate, errm, 'RESOLUTION FAILURE');
        n_resolution := n_resolution + 1;
      else
        insert into resolution_results values (r.proname, r.ident_args, errstate, left(errm, 120), 'business error, fine');
        n_business := n_business + 1;
      end if;
    end;
  end loop;

  raise notice 'called cleanly: %, business errors: %, RESOLUTION FAILURES: %',
    n_ok, n_business, n_resolution;
end $$;

select verdict, count(*) as functions
from resolution_results
group by verdict
order by verdict;

-- The only section that matters. Anything here needs its body qualified before this ships.
select fname, args, sqlstate, message
from resolution_results
where verdict = 'RESOLUTION FAILURE'
order by fname;
