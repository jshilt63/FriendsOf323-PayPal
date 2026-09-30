-- Friends of 323
-- Delivery drivers and imported Google My Maps KML/KMZ route geometry.
-- Routes are stored as GeoJSON MultiLineString JSON so PostGIS is not required.

begin;

create table if not exists public.delivery_drivers (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (btrim(display_name) <> ''),
  email text,
  phone text,
  starting_area text,
  notes text,
  user_profile_id uuid references public.user_profiles(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id)
);

create table if not exists public.delivery_driver_routes (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.delivery_drivers(id) on delete cascade,
  route_name text not null check (btrim(route_name) <> ''),
  route_type text not null default 'normal_commute'
    check (route_type in ('normal_commute', 'pack_meeting', 'other')),
  description text,
  allowed_distance_miles numeric(6,2) not null default 5.00
    check (allowed_distance_miles >= 0 and allowed_distance_miles <= 100),
  is_active boolean not null default true,
  source_filename text,
  source_format text check (source_format in ('kml', 'kmz')),
  geometry jsonb not null,
  point_count integer not null default 0 check (point_count >= 0),
  bounds jsonb,
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  constraint delivery_driver_routes_geometry_type check (
    geometry ->> 'type' = 'MultiLineString'
    and jsonb_typeof(geometry -> 'coordinates') = 'array'
  )
);

create index if not exists delivery_drivers_active_name_idx
  on public.delivery_drivers (is_active desc, display_name);

create index if not exists delivery_driver_routes_driver_idx
  on public.delivery_driver_routes (driver_id, is_active desc, route_name);

create index if not exists delivery_driver_routes_active_idx
  on public.delivery_driver_routes (is_active)
  where is_active;

-- Keep updated_at consistent with the rest of the portal.
drop trigger if exists delivery_drivers_set_updated_at on public.delivery_drivers;
create trigger delivery_drivers_set_updated_at
before update on public.delivery_drivers
for each row execute function public.set_updated_at();

drop trigger if exists delivery_driver_routes_set_updated_at on public.delivery_driver_routes;
create trigger delivery_driver_routes_set_updated_at
before update on public.delivery_driver_routes
for each row execute function public.set_updated_at();

-- Include driver changes in the existing Administration audit log.
drop trigger if exists audit_delivery_drivers on public.delivery_drivers;
create trigger audit_delivery_drivers
after insert or update or delete on public.delivery_drivers
for each row execute function public.write_audit_log();

drop trigger if exists audit_delivery_driver_routes on public.delivery_driver_routes;
create trigger audit_delivery_driver_routes
after insert or update or delete on public.delivery_driver_routes
for each row execute function public.write_audit_log();

alter table public.delivery_drivers enable row level security;
alter table public.delivery_driver_routes enable row level security;

-- Any active committee portal user may read driver/route information. This lets
-- order and delivery screens use route eligibility later without relaxing writes.
drop policy if exists delivery_drivers_read on public.delivery_drivers;
create policy delivery_drivers_read
on public.delivery_drivers
for select
to authenticated
using (public.is_active_user());

drop policy if exists delivery_driver_routes_read on public.delivery_driver_routes;
create policy delivery_driver_routes_read
on public.delivery_driver_routes
for select
to authenticated
using (public.is_active_user());

-- Only Coffee Bean administrators can maintain drivers or route geometry.
drop policy if exists delivery_drivers_admin_manage on public.delivery_drivers;
create policy delivery_drivers_admin_manage
on public.delivery_drivers
for all
to authenticated
using (public.has_any_role(array['coffee_bean']::public.app_role[]))
with check (public.has_any_role(array['coffee_bean']::public.app_role[]));

drop policy if exists delivery_driver_routes_admin_manage on public.delivery_driver_routes;
create policy delivery_driver_routes_admin_manage
on public.delivery_driver_routes
for all
to authenticated
using (public.has_any_role(array['coffee_bean']::public.app_role[]))
with check (public.has_any_role(array['coffee_bean']::public.app_role[]));

grant select, insert, update, delete on public.delivery_drivers to authenticated;
grant select, insert, update, delete on public.delivery_driver_routes to authenticated;

comment on column public.delivery_driver_routes.geometry is
  'GeoJSON MultiLineString. Coordinate order is longitude, latitude.';
comment on column public.delivery_driver_routes.bounds is
  'JSON object containing min_lng, min_lat, max_lng, max_lat.';

commit;
