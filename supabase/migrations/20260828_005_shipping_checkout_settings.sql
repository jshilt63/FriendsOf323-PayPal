-- Friends of 323
-- Global storefront shipping enable/disable setting.

begin;

create table if not exists public.storefront_settings (
  id smallint primary key default 1 check (id = 1),
  shipping_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

insert into public.storefront_settings (id, shipping_enabled)
values (1, false)
on conflict (id) do nothing;

drop trigger if exists storefront_settings_set_updated_at on public.storefront_settings;
create trigger storefront_settings_set_updated_at
before update on public.storefront_settings
for each row execute function public.set_updated_at();

drop trigger if exists audit_storefront_settings on public.storefront_settings;
create trigger audit_storefront_settings
after insert or update or delete on public.storefront_settings
for each row execute function public.write_audit_log();

alter table public.storefront_settings enable row level security;

drop policy if exists storefront_settings_read on public.storefront_settings;
create policy storefront_settings_read
on public.storefront_settings
for select
to authenticated
using (public.is_active_user());

drop policy if exists storefront_settings_admin_manage on public.storefront_settings;
create policy storefront_settings_admin_manage
on public.storefront_settings
for all
to authenticated
using (public.has_any_role(array['coffee_bean']::public.app_role[]))
with check (public.has_any_role(array['coffee_bean']::public.app_role[]));

grant select, insert, update on public.storefront_settings to authenticated;

commit;
