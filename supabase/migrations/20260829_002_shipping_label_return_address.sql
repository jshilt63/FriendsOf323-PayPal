-- Friends of 323
-- Return address used on non-postage 5 x 3.5 Heritage Coffee shipping labels.

begin;

alter table public.storefront_settings
  add column if not exists shipping_return_name text,
  add column if not exists shipping_return_address_line_1 text,
  add column if not exists shipping_return_address_line_2 text,
  add column if not exists shipping_return_city text,
  add column if not exists shipping_return_state text,
  add column if not exists shipping_return_postal_code text;

commit;
