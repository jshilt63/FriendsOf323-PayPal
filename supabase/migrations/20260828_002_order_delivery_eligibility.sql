-- Friends of 323
-- Cached order delivery eligibility results.
-- Safe to run after 20260828_001_delivery_route_matching.sql.

begin;

create table if not exists public.order_delivery_eligibility (
  order_id uuid primary key references public.orders(id) on delete cascade,
  status text not null check (status in (
    'eligible',
    'shipping_required',
    'no_address',
    'geocode_failed',
    'no_active_areas'
  )),
  address_snapshot text,
  matches jsonb not null default '[]'::jsonb,
  route_config_updated_at timestamptz,
  checked_at timestamptz not null default now(),
  error_message text,
  checked_by uuid references auth.users(id)
);

alter table public.order_delivery_eligibility
  drop constraint if exists order_delivery_eligibility_matches_array;
alter table public.order_delivery_eligibility
  add constraint order_delivery_eligibility_matches_array
  check (jsonb_typeof(matches) = 'array');

create index if not exists order_delivery_eligibility_status_idx
  on public.order_delivery_eligibility (status, checked_at desc);

alter table public.order_delivery_eligibility enable row level security;

drop policy if exists order_delivery_eligibility_read on public.order_delivery_eligibility;
create policy order_delivery_eligibility_read
on public.order_delivery_eligibility
for select
to authenticated
using (public.is_active_user());

drop policy if exists order_delivery_eligibility_admin_manage on public.order_delivery_eligibility;
create policy order_delivery_eligibility_admin_manage
on public.order_delivery_eligibility
for all
to authenticated
using (public.has_any_role(array['coffee_bean']::public.app_role[]))
with check (public.has_any_role(array['coffee_bean']::public.app_role[]));

grant select, insert, update, delete on public.order_delivery_eligibility to authenticated;

comment on table public.order_delivery_eligibility is
  'Cached local-delivery eligibility for an order. Kept separate from orders so route checks do not alter order workflow or order audit history.';
comment on column public.order_delivery_eligibility.matches is
  'JSON array of evaluated active delivery areas, including driver/area names, distance, threshold, and eligibility.';
comment on column public.order_delivery_eligibility.route_config_updated_at is
  'Newest driver or delivery-area updated_at included in this evaluation. Used to detect stale results.';

commit;
