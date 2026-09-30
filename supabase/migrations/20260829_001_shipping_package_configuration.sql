-- Friends of 323
-- Convert bag-count shipping tiers into package configuration for USPS rating.
-- Existing flat rates are retained as optional fallback rates while USPS integration is staged.

begin;

alter table public.shipping_rate_tiers
  add column if not exists package_length_inches numeric(8,2)
    check (package_length_inches is null or package_length_inches > 0),
  add column if not exists package_width_inches numeric(8,2)
    check (package_width_inches is null or package_width_inches > 0),
  add column if not exists package_height_inches numeric(8,2)
    check (package_height_inches is null or package_height_inches > 0),
  add column if not exists package_weight_ounces numeric(8,2)
    check (package_weight_ounces is null or package_weight_ounces >= 0);

-- USPS will become the primary source of the postage amount.  A fallback rate is
-- intentionally optional so package rows can be configured before rates are known.
alter table public.shipping_rate_tiers
  alter column rate_amount drop not null;

comment on table public.shipping_rate_tiers is
  'Bag-count package configurations used for USPS rating. rate_amount is an optional fallback shipping charge.';
comment on column public.shipping_rate_tiers.label is
  'Administrative package name, for example Small Box or 3-4 Bag Box.';
comment on column public.shipping_rate_tiers.package_length_inches is
  'Outside package length in inches supplied to USPS rating.';
comment on column public.shipping_rate_tiers.package_width_inches is
  'Outside package width in inches supplied to USPS rating.';
comment on column public.shipping_rate_tiers.package_height_inches is
  'Outside package height in inches supplied to USPS rating.';
comment on column public.shipping_rate_tiers.package_weight_ounces is
  'Empty package/tare weight in ounces. Coffee product weight is added separately.';
comment on column public.shipping_rate_tiers.rate_amount is
  'Optional fallback shipping charge. USPS calculated postage will be primary when enabled.';

commit;
