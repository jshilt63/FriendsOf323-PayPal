-- Friends of 323
-- Route visualization, point/radius delivery zones, and cached customer geocoding.
-- Safe to run after 20260825_001_delivery_drivers_and_routes.sql.

begin;

alter table public.delivery_driver_routes
  add column if not exists coverage_type text not null default 'path',
  add column if not exists center_address text,
  add column if not exists center_latitude double precision,
  add column if not exists center_longitude double precision;

alter table public.delivery_driver_routes
  drop constraint if exists delivery_driver_routes_coverage_type_check;
alter table public.delivery_driver_routes
  add constraint delivery_driver_routes_coverage_type_check
  check (coverage_type in ('path', 'radius'));

-- Point/radius coverage has no imported line geometry, so imported geometry must be optional.
alter table public.delivery_driver_routes
  alter column geometry drop not null;

alter table public.delivery_driver_routes
  drop constraint if exists delivery_driver_routes_geometry_type;
alter table public.delivery_driver_routes
  add constraint delivery_driver_routes_geometry_type check (
    (
      coverage_type = 'path'
      and geometry is not null
      and geometry ->> 'type' = 'MultiLineString'
      and jsonb_typeof(geometry -> 'coordinates') = 'array'
    )
    or
    (
      coverage_type = 'radius'
      and geometry is null
      and center_latitude between -90 and 90
      and center_longitude between -180 and 180
    )
  );

alter table public.delivery_driver_routes
  drop constraint if exists delivery_driver_routes_center_address_check;
alter table public.delivery_driver_routes
  add constraint delivery_driver_routes_center_address_check check (
    coverage_type <> 'radius' or nullif(btrim(center_address), '') is not null
  );

-- Cache geocoded customer coordinates. The address snapshot lets the app know when
-- the cache is stale because a customer's address has changed.
alter table public.customers
  add column if not exists geocode_latitude double precision,
  add column if not exists geocode_longitude double precision,
  add column if not exists geocode_address text,
  add column if not exists geocode_source text,
  add column if not exists geocoded_at timestamptz;

alter table public.customers
  drop constraint if exists customers_geocode_latitude_check;
alter table public.customers
  add constraint customers_geocode_latitude_check
  check (geocode_latitude is null or geocode_latitude between -90 and 90);

alter table public.customers
  drop constraint if exists customers_geocode_longitude_check;
alter table public.customers
  add constraint customers_geocode_longitude_check
  check (geocode_longitude is null or geocode_longitude between -180 and 180);

comment on column public.delivery_driver_routes.coverage_type is
  'path = imported KML/KMZ line; radius = center address plus allowed_distance_miles circle.';
comment on column public.delivery_driver_routes.center_address is
  'Center address used for radius coverage.';
comment on column public.customers.geocode_address is
  'Normalized address snapshot used when geocode_latitude/geocode_longitude were last calculated.';
comment on column public.customers.geocode_source is
  'Geocoding provider used for the cached coordinates.';

commit;
