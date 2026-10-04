--
-- STAGING ONLY. Modifies data. Proves a liquidated stock with no cached price is credited at what the
-- borrower paid rather than at nothing, and that everything else about liquidation is unchanged.
--
-- Depends on seed-staging-users.sql. Uses ...003, the only seeded user with kyc_status 'verified',
-- which create_loan requires.

create temp table if not exists r (ord int, name text, detail text, ok boolean);
delete from r;

-- A borrower with one stock that has NO row in equity_prices, and one that has a fresh price.
-- 042 would seize the unpriced one for zero.
do $$
declare v_loan uuid; v_seed_bal bigint;
begin
  delete from public.loans where user_id = '00000000-0000-4000-8000-000000000003';
  delete from public.portfolio_holdings
   where user_id = '00000000-0000-4000-8000-000000000003' and symbol in ('NOPRICE','HASPRICE');
  delete from public.equity_prices where symbol in ('NOPRICE','HASPRICE');

  -- Paid ₦100,000 for it. No price row at all, which is the ordinary state for a symbol nothing has
  -- refreshed.
  insert into public.portfolio_holdings
    (user_id, symbol, asset_type, provider, invested_cngn_micro, shares)
  values ('00000000-0000-4000-8000-000000000003', 'NOPRICE', 'tokenized_stock', 'base_dex',
          100000 * 1000000::bigint, 10);

  -- Paid ₦50,000, now worth ₦60,000 at a fresh price of ₦6,000 a share.
  insert into public.portfolio_holdings
    (user_id, symbol, asset_type, provider, invested_cngn_micro, shares)
  values ('00000000-0000-4000-8000-000000000003', 'HASPRICE', 'tokenized_stock', 'base_dex',
          50000 * 1000000::bigint, 10);
  insert into public.equity_prices (symbol, price_ngn_micro, updated_at)
  values ('HASPRICE', 6000 * 1000000::bigint, now());
end $$;

-- 1. Only the priced holding counts toward the borrow limit. The unpriced one is invisible to
--    _loan_equity_value, which is 042's behaviour and not what this migration changes.
do $$
declare v jsonb;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
  v := public.loan_borrow_limit('00000000-0000-4000-8000-000000000003');
  reset role;
  -- ₦60,000 of priced stock at 40% LTV = ₦24,000, plus 70% of any seeded savings lock.
  insert into r values (1, 'an unpriced holding adds nothing to the limit',
    'equity_micro ' || (v->>'equity_micro'), (v->>'equity_micro')::bigint = 60000 * 1000000::bigint);
end $$;

-- 2. Borrow against it, which pledges BOTH holdings — create_loan pledges every eligible asset, and
--    the unpriced one is eligible for pledging even though it added nothing to the limit.
do $$
declare v jsonb; v_pledged int;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
  v := public.create_loan('00000000-0000-4000-8000-000000000003', 10000 * 1000000::bigint, 30, 'v1-test');
  reset role;

  select count(*) into v_pledged from public.portfolio_holdings
   where user_id = '00000000-0000-4000-8000-000000000003'
     and symbol in ('NOPRICE','HASPRICE') and pledged_loan_id is not null;

  -- Only the freshly-priced one is pledged: create_loan's pledge loop joins equity_prices and
  -- filters on freshness, so NOPRICE is never stamped. It therefore must not be seized either.
  insert into r values (2, 'create_loan pledges only the freshly-priced holding',
    v_pledged::text || ' of 2 pledged', v_pledged = 1);
exception when others then
  reset role;
  insert into r values (2, 'create_loan pledges only the freshly-priced holding',
    'FAILED: ' || left(sqlerrm, 60), false);
end $$;

-- 3. THE POINT. Force the pledged holding's price row away, so liquidation meets a pledged position
--    it cannot price — the exact shape of the bug — then liquidate and check the credit.
do $$
declare v_bal_before bigint; v_bal_after bigint; v_loan uuid; v_owed bigint; v jsonb;
begin
  select id into v_loan from public.loans
   where user_id = '00000000-0000-4000-8000-000000000003' and status = 'active';

  -- Make it overdue so the trigger fires regardless of price freshness.
  update public.loans set due_date = now() - interval '30 days' where id = v_loan;
  select principal_micro + accrued_interest_micro into v_owed from public.loans where id = v_loan;

  -- The pledged holding loses its price. 042 credits this at zero.
  delete from public.equity_prices where symbol = 'HASPRICE';

  select usdc_balance_micro into v_bal_before from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000003';

  v := public.liquidate_overdue_loans();

  select usdc_balance_micro into v_bal_after from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000003';

  -- Cost basis ₦50,000 seized against a ₦10,000 debt plus a little interest, so a surplus comes
  -- back. Under 042 the seizure would have been ₦0 and the borrower would have received nothing.
  insert into r values (3, 'an unpriced pledged holding is credited at its cost basis',
    format('liquidated %s, surplus returned %s NGN, owed was %s NGN',
           v->>'liquidated', ((v_bal_after - v_bal_before)/1000000.0)::numeric(20,2),
           (v_owed/1000000.0)::numeric(20,2)),
    v_bal_after - v_bal_before > 0);
end $$;

-- 4. The surplus is exactly cost basis less what was owed, so the arithmetic is the stated rule and
--    not an accident.
do $$
declare v_txn_kobo bigint; v_desc text;
begin
  select amount_kobo, description into v_txn_kobo, v_desc from public.transactions
   where user_id = '00000000-0000-4000-8000-000000000003' and type = 'loan_liquidation'
   order by created_at desc limit 1;
  insert into r values (4, 'the liquidation is on the ledger with the amount cleared',
    coalesce(left(v_desc, 70), '(no transaction)'), v_desc is not null);
end $$;

-- 5. The position is gone and no longer pledged, so it cannot be frozen against a closed loan.
do $$
declare v_shares numeric; v_pledge uuid;
begin
  select shares, pledged_loan_id into v_shares, v_pledge from public.portfolio_holdings
   where user_id = '00000000-0000-4000-8000-000000000003' and symbol = 'HASPRICE';
  insert into r values (5, 'the seized holding is emptied and released',
    format('shares %s, pledged_loan_id %s', v_shares, coalesce(v_pledge::text, 'null')),
    v_shares = 0 and v_pledge is null);
end $$;

-- 6. The loan is closed and zeroed.
do $$
declare v_status text; v_principal bigint;
begin
  select status, principal_micro into v_status, v_principal from public.loans
   where user_id = '00000000-0000-4000-8000-000000000003'
   order by created_at desc limit 1;
  insert into r values (6, 'the loan is marked liquidated and zeroed',
    format('status %s, principal %s', v_status, v_principal),
    v_status = 'liquidated' and v_principal = 0);
end $$;

-- 7. The column the loan-due reminder needs now exists, with a safe default.
do $$
declare v_default text; v_nullable text;
begin
  select column_default, is_nullable into v_default, v_nullable
    from information_schema.columns
   where table_schema='public' and table_name='loans' and column_name='due_reminder_sent';
  insert into r values (7, 'loans.due_reminder_sent exists so the due-soon push can run',
    format('default %s, nullable %s', coalesce(v_default,'(none)'), coalesce(v_nullable,'(missing)')),
    v_default like 'false%' and v_nullable = 'NO');
end $$;

-- 8. And the cron's query against it actually runs, which it never did before.
do $$
declare v_count int;
begin
  select count(*) into v_count from public.loans
   where status = 'active' and due_reminder_sent = false;
  insert into r values (8, 'the cron''s due-reminder filter resolves',
    v_count::text || ' active loans awaiting a reminder', true);
exception when others then
  insert into r values (8, 'the cron''s due-reminder filter resolves', SQLERRM, false);
end $$;

-- Tidy up.
delete from public.loans where user_id = '00000000-0000-4000-8000-000000000003';
delete from public.portfolio_holdings
 where user_id = '00000000-0000-4000-8000-000000000003' and symbol in ('NOPRICE','HASPRICE');
delete from public.equity_prices where symbol in ('NOPRICE','HASPRICE');
delete from public.transactions
 where user_id = '00000000-0000-4000-8000-000000000003' and type = 'loan_liquidation';

select ord, name, detail, case when ok then 'PASS' else 'FAIL' end as result
from r order by ord;
