-- Fix infinite recursion in esusu_members RLS policies
-- The old "Members read members" policy queries esusu_members within its own policy, causing recursion.
-- Fix: Use a SECURITY DEFINER function that bypasses RLS to check membership.

-- Step 1: Create helper function (SECURITY DEFINER bypasses RLS, no recursion)
create or replace function public.is_group_member(p_group_id uuid)
returns boolean as $$
  select exists (
    select 1 from public.esusu_members
    where group_id = p_group_id and user_id = auth.uid()
  );
$$ language sql security definer stable;

-- Step 2: Drop the recursive policies
drop policy if exists "Members read members" on public.esusu_members;
drop policy if exists "Members read groups" on public.esusu_groups;
drop policy if exists "Members read contributions" on public.esusu_contributions;
drop policy if exists "Members insert contributions" on public.esusu_contributions;
drop policy if exists "Members read requests" on public.emergency_requests;
drop policy if exists "Members read votes" on public.emergency_votes;

-- Step 3: Recreate policies using the helper function (no recursion)

-- esusu_members: user can see own memberships + all members of groups they belong to
create policy "Members read members" on public.esusu_members for select using (
  user_id = auth.uid() or is_group_member(group_id)
);

-- esusu_groups: members can read their groups
create policy "Members read groups" on public.esusu_groups for select using (
  owner_id = auth.uid() or is_group_member(id)
);

-- esusu_contributions: members can read contributions in their groups
create policy "Members read contributions" on public.esusu_contributions for select using (
  is_group_member(group_id)
);

-- esusu_contributions: members can insert their own contributions
create policy "Members insert contributions" on public.esusu_contributions for insert with check (
  exists (select 1 from public.esusu_members m where m.id = member_id and m.user_id = auth.uid())
);

-- emergency_requests: members can read requests in their groups
create policy "Members read requests" on public.emergency_requests for select using (
  is_group_member(group_id)
);

-- emergency_votes: members can read votes for requests in their groups
create policy "Members read votes" on public.emergency_votes for select using (
  exists (
    select 1 from public.emergency_requests r
    where r.id = emergency_votes.request_id
    and is_group_member(r.group_id)
  )
);
