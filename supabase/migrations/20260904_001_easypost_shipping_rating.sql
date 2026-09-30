-- EasyPost USPS Ground Advantage rating metadata.
-- Run before deploying the EasyPost checkout integration.

alter table public.orders
  add column if not exists shipping_rate_source text,
  add column if not exists shipping_carrier text,
  add column if not exists shipping_service text,
  add column if not exists shipping_rate_environment text,
  add column if not exists shipping_rate_retail numeric(10,2),
  add column if not exists shipping_rate_list numeric(10,2),
  add column if not exists shipping_rate_account numeric(10,2),
  add column if not exists shipping_package_weight_ounces numeric(10,2),
  add column if not exists shipping_easypost_rate_id text,
  add column if not exists shipping_easypost_shipment_id text;

comment on column public.orders.shipping_rate_source is
  'Source used to calculate the customer shipping charge, currently easypost or fallback.';
comment on column public.orders.shipping_rate_environment is
  'EasyPost environment used for the quote: test or production.';
comment on column public.orders.shipping_rate_retail is
  'USPS retail/Post Office rate returned by EasyPost.';
comment on column public.orders.shipping_rate_list is
  'USPS list rate returned by EasyPost.';
comment on column public.orders.shipping_rate_account is
  'EasyPost account/purchasable rate returned by EasyPost.';
comment on column public.orders.shipping_package_weight_ounces is
  'Total rated parcel weight, including coffee contents and empty package.';
