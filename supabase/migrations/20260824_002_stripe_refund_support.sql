-- Friends of 323
-- Stripe refund audit fields
-- Safe to run more than once.

begin;

alter table public.orders
  add column if not exists refund_transaction_id text,
  add column if not exists refunded_amount numeric(12,2),
  add column if not exists refunded_at timestamptz;

comment on column public.orders.refund_transaction_id is
  'Stripe Refund ID (re_...) for the most recent full order refund.';
comment on column public.orders.refunded_amount is
  'Amount returned to the customer for the Stripe refund.';
comment on column public.orders.refunded_at is
  'Timestamp when the Stripe refund was recorded by Friends of 323.';

commit;
