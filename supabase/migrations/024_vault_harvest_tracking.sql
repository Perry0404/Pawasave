-- Migration 024: P-AUTO Vault Harvest Tracking
-- Tracks on-chain yield harvests from PawasaveAutoVault
-- and distributes yield proportionally to active savings_locks holders

-- ── vault_harvests table ──────────────────────────────────────────────────────
create table if not exists vault_harvests (
  id                   uuid primary key default gen_random_uuid(),
  tx_hash              text not null unique,
  total_yield_micro    bigint not null default 0,  -- total cNGN yield (6 dec)
  platform_fee_micro   bigint not null default 0,  -- 6% platform cut
  user_yield_micro     bigint not null default 0,  -- distributed to users
  harvested_at         timestamptz not null default now()
);

alter table vault_harvests enable row level security;

-- Admins can read harvest history
create policy "admins_read_harvests"
  on vault_harvests for select
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
      and profiles.is_admin = true
    )
  );

-- Only service role can insert (called by harvest cron)
create policy "service_insert_harvests"
  on vault_harvests for insert
  with check (true);

-- ── distribute_vault_yield RPC ────────────────────────────────────────────────
-- Distributes harvested yield proportionally to all active savings_locks
-- holders based on their locked amount relative to total locked.
create or replace function distribute_vault_yield(p_yield_micro bigint)
returns void
language plpgsql
security definer
as $$
declare
  v_total_locked      bigint;
  v_lock              record;
  v_user_share        bigint;
begin
  if p_yield_micro <= 0 then
    return;
  end if;

  -- Sum of all active locked savings
  select coalesce(sum(amount_usdc_micro), 0)
    into v_total_locked
    from savings_locks
   where status = 'active';

  if v_total_locked = 0 then
    return;
  end if;

  -- Distribute proportionally to each active lock
  for v_lock in
    select id, user_id, amount_usdc_micro
      from savings_locks
     where status = 'active'
  loop
    -- Share = yield × (user_locked / total_locked)
    v_user_share := (p_yield_micro::numeric * v_lock.amount_usdc_micro / v_total_locked)::bigint;

    if v_user_share > 0 then
      -- Credit yield to user's wallet
      update wallets
         set usdc_micro = usdc_micro + v_user_share,
             updated_at = now()
       where user_id = v_lock.user_id;

      -- Record the yield credit as a transaction
      insert into transactions (
        user_id, type, amount_kobo, amount_usdc_micro,
        status, description, created_at
      ) values (
        v_lock.user_id,
        'yield',
        0,
        v_user_share,
        'completed',
        'P-AUTO vault yield distribution',
        now()
      );
    end if;
  end loop;
end;
$$;

-- Grant execute to service role
grant execute on function distribute_vault_yield(bigint) to service_role;

comment on table vault_harvests is
  'On-chain yield harvest events from PawasaveAutoVault (called every 24h by Vercel cron)';

comment on function distribute_vault_yield is
  'Distributes P-AUTO vault yield proportionally to all active savings_locks holders';
