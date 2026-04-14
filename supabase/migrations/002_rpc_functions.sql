-- Wallet RPC functions (run after initial migration)

-- Credit wallet (used by webhooks and internal operations)
create or replace function public.credit_wallet(
  p_user_id uuid,
  p_naira_kobo bigint default 0,
  p_usdc_micro bigint default 0
) returns void as $$
begin
  update public.wallets
  set naira_balance_kobo = naira_balance_kobo + p_naira_kobo,
      usdc_balance_micro = usdc_balance_micro + p_usdc_micro,
      updated_at = now()
  where user_id = p_user_id;
end;
$$ language plpgsql security definer;

-- Debit wallet (with balance check)
create or replace function public.debit_wallet(
  p_user_id uuid,
  p_naira_kobo bigint default 0,
  p_usdc_micro bigint default 0
) returns boolean as $$
declare
  w public.wallets%rowtype;
begin
  select * into w from public.wallets where user_id = p_user_id for update;
  if w.naira_balance_kobo < p_naira_kobo or w.usdc_balance_micro < p_usdc_micro then
    return false;
  end if;
  update public.wallets
  set naira_balance_kobo = naira_balance_kobo - p_naira_kobo,
      usdc_balance_micro = usdc_balance_micro - p_usdc_micro,
      updated_at = now()
  where user_id = p_user_id;
  return true;
end;
$$ language plpgsql security definer;

-- Save to vault (naira → usdc)
create or replace function public.save_to_vault(
  p_user_id uuid,
  p_naira_kobo bigint,
  p_usdc_micro bigint
) returns boolean as $$
declare
  w public.wallets%rowtype;
begin
  select * into w from public.wallets where user_id = p_user_id for update;
  if w.naira_balance_kobo < p_naira_kobo then
    return false;
  end if;
  update public.wallets
  set naira_balance_kobo = naira_balance_kobo - p_naira_kobo,
      usdc_balance_micro = usdc_balance_micro + p_usdc_micro,
      total_saved_kobo = total_saved_kobo + p_naira_kobo,
      updated_at = now()
  where user_id = p_user_id;
  return true;
end;
$$ language plpgsql security definer;

-- Withdraw from vault (usdc → naira)
create or replace function public.withdraw_from_vault(
  p_user_id uuid,
  p_naira_kobo bigint,
  p_usdc_micro bigint
) returns boolean as $$
declare
  w public.wallets%rowtype;
begin
  select * into w from public.wallets where user_id = p_user_id for update;
  if w.usdc_balance_micro < p_usdc_micro then
    return false;
  end if;
  update public.wallets
  set naira_balance_kobo = naira_balance_kobo + p_naira_kobo,
      usdc_balance_micro = usdc_balance_micro - p_usdc_micro,
      total_withdrawn_kobo = total_withdrawn_kobo + p_naira_kobo,
      updated_at = now()
  where user_id = p_user_id;
  return true;
end;
$$ language plpgsql security definer;

-- Esusu contribute
create or replace function public.esusu_contribute(
  p_user_id uuid,
  p_group_id uuid,
  p_member_id uuid,
  p_amount_kobo bigint,
  p_cycle int
) returns boolean as $$
declare
  w public.wallets%rowtype;
begin
  select * into w from public.wallets where user_id = p_user_id for update;
  if w.naira_balance_kobo < p_amount_kobo then
    return false;
  end if;

  -- Debit user
  update public.wallets
  set naira_balance_kobo = naira_balance_kobo - p_amount_kobo, updated_at = now()
  where user_id = p_user_id;

  -- Credit group pot (5% to emergency)
  update public.esusu_groups
  set pot_balance_kobo = pot_balance_kobo + (p_amount_kobo * 95 / 100),
      emergency_pot_kobo = emergency_pot_kobo + (p_amount_kobo * 5 / 100)
  where id = p_group_id;

  -- Record contribution
  insert into public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
  values (p_group_id, p_member_id, p_cycle, p_amount_kobo);

  return true;
end;
$$ language plpgsql security definer;
