-- Configurable packaging charge for EasyPost shipping.
-- Customer shipping = EasyPost USPS Ground Advantage account rate + packaging charge.

alter table public.storefront_settings
  add column if not exists shipping_packaging_charge numeric(10,2) not null default 2.00
    check (shipping_packaging_charge >= 0);

alter table public.orders
  add column if not exists shipping_postage_amount numeric(10,2),
  add column if not exists shipping_packaging_charge numeric(10,2);

comment on column public.storefront_settings.shipping_packaging_charge is
  'Packaging/material charge added to the EasyPost USPS account postage rate.';
comment on column public.orders.shipping_postage_amount is
  'EasyPost USPS account postage component of the customer shipping charge.';
comment on column public.orders.shipping_packaging_charge is
  'Packaging component of the customer shipping charge saved at checkout.';
