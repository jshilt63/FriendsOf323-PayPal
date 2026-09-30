-- Friends of 323 Portal v1.4.1 hotfix
-- Allows active signed-in portal users to read the den list used by dropdowns.

alter table public.dens enable row level security;

drop policy if exists dens_read_active_portal_users on public.dens;
create policy dens_read_active_portal_users
on public.dens
for select
to authenticated
using (
  exists (
    select 1
    from public.user_profiles up
    where up.id = (select auth.uid())
      and up.is_active = true
  )
);
