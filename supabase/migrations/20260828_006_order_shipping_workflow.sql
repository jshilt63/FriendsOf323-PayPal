-- Friends of 323
-- Shipping fulfillment workflow for orders.
-- Adds shipping-specific status, carrier, tracking, and timestamps while
-- retaining delivery_status for the overall fulfilled/delivered state.

begin;

alter table public.orders
  add column if not exists shipping_status text not null default 'not_ready',
  add column if not exists shipping_carrier text,
  add column if not exists shipping_tracking_number text,
  add column if not exists shipping_shipped_at timestamptz,
  add column if not exists shipping_delivered_at timestamptz;

alter table public.orders
  drop constraint if exists orders_shipping_status_check;
alter table public.orders
  add constraint orders_shipping_status_check
  check (shipping_status in ('not_ready', 'ready_to_ship', 'shipped', 'delivered'));

comment on column public.orders.shipping_status is
  'Shipping-only fulfillment workflow: not_ready, ready_to_ship, shipped, delivered.';
comment on column public.orders.shipping_carrier is
  'Carrier used for a shipped order, such as USPS, UPS, FedEx, or Other.';
comment on column public.orders.shipping_tracking_number is
  'Carrier tracking number for a shipped order.';
comment on column public.orders.shipping_shipped_at is
  'Timestamp when the order was marked shipped.';
comment on column public.orders.shipping_delivered_at is
  'Timestamp when the shipped order was marked delivered.';

create index if not exists orders_shipping_workflow_idx
  on public.orders (fulfillment_method, shipping_status)
  where fulfillment_method = 'shipping' and record_status = 'active';

commit;
