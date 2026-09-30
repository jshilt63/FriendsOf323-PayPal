-- Friends of 323 den assignments
-- Scouts keep a permanent den_id. The rank worked toward is maintained on public.dens.

begin;

alter table public.user_profiles
  add column if not exists den_id uuid references public.dens(id) on delete set null;

create index if not exists idx_user_profiles_den_id on public.user_profiles(den_id);
create index if not exists idx_scouts_den_id on public.scouts(den_id);

-- Only Baristas use an assigned den in the current portal model.
update public.user_profiles
set den_id = null
where role <> 'barista' and den_id is not null;

commit;

-- Portal users need read access to dens so scout and Barista selectors can be populated.
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
