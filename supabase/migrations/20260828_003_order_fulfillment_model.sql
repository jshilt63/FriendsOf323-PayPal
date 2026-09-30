-- Friends of 323
-- Order fulfillment model: Pickup, Local Delivery, or Shipping.
-- Also includes the manual local-delivery exception that was prepared after
-- 20260828_002_order_delivery_eligibility.sql.
-- Safe to run once after 20260828_002. Uses IF NOT EXISTS where practical.

begin;

alter table public.orders
  add column if not exists fulfillment_method text,
  add column if not exists fulfillment_notes text;

alter table public.orders
  drop constraint if exists orders_fulfillment_method_check;
alter table public.orders
  add constraint orders_fulfillment_method_check
  check (
    fulfillment_method is null
    or fulfillment_method in ('pickup', 'local_delivery', 'shipping')
  );

comment on column public.orders.fulfillment_method is
  'How the customer expects to receive the order: pickup, local_delivery, or shipping. Null means a legacy order has not yet been classified.';
comment on column public.orders.fulfillment_notes is
  'Optional fulfillment-specific note. This is separate from general order notes.';

alter table public.order_delivery_eligibility
  add column if not exists manual_local_override boolean not null default false,
  add column if not exists manual_local_reason text,
  add column if not exists manual_local_at timestamptz,
  add column if not exists manual_local_by uuid references auth.users(id);

alter table public.order_delivery_eligibility
  drop constraint if exists order_delivery_eligibility_manual_local_reason_required;
alter table public.order_delivery_eligibility
  add constraint order_delivery_eligibility_manual_local_reason_required
  check (
    manual_local_override = false
    or nullif(btrim(manual_local_reason), '') is not null
  );

comment on column public.order_delivery_eligibility.manual_local_override is
  'Coffee Bean manual exception allowing local delivery even when automatic route/radius matching does not qualify.';
comment on column public.order_delivery_eligibility.manual_local_reason is
  'Reason for the local-delivery exception.';

commit;
