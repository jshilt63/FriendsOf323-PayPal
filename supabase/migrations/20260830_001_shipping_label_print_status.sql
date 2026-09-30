-- Track when a non-postage shipping/address label was last printed for an order.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shipping_label_printed_at timestamptz,
  ADD COLUMN IF NOT EXISTS shipping_label_printed_by uuid REFERENCES auth.users(id);

COMMENT ON COLUMN public.orders.shipping_label_printed_at IS
  'Most recent time the Heritage Coffee address/shipping label was sent to print.';
COMMENT ON COLUMN public.orders.shipping_label_printed_by IS
  'Portal user who most recently sent the Heritage Coffee address/shipping label to print.';
