-- Friends of 323
-- Fix Stripe payment confirmation so the validated order total includes shipping.
-- Safe for Stripe webhook retries: an already-confirmed matching payment returns
-- successfully instead of recording the payment twice.

begin;

-- Recreate the RPC used by netlify/functions/stripe-webhook.mjs. Dropping the
-- exact signature avoids depending on the return type of an older deployment.
drop function if exists public.confirm_storefront_stripe_payment(
  uuid,
  text,
  text,
  numeric,
  timestamptz
);

create function public.confirm_storefront_stripe_payment(
  p_order_id uuid,
  p_session_id text,
  p_payment_intent_id text,
  p_amount_paid numeric,
  p_event_created_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_expected_total numeric(12,2);
  v_item_total numeric(12,2);
  v_processing_cost numeric(12,2);
  v_shipping_amount numeric(12,2);
  v_already_processed boolean := false;
begin
  if p_order_id is null then
    raise exception 'Order ID is required.';
  end if;

  if coalesce(btrim(p_session_id), '') = '' then
    raise exception 'Stripe Checkout Session ID is required.';
  end if;

  if p_amount_paid is null or p_amount_paid < 0 then
    raise exception 'Stripe payment amount is invalid.';
  end if;

  select o.*
    into v_order
  from public.orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Order % was not found.', p_order_id;
  end if;

  -- The session saved when Checkout was created must be the one confirming
  -- this order. Allow NULL only for older orders that predate session storage.
  if v_order.payment_session_id is not null
     and v_order.payment_session_id <> p_session_id then
    raise exception 'Stripe Checkout Session does not match this order.';
  end if;

  select coalesce(sum(oi.line_total), 0)::numeric(12,2)
    into v_item_total
  from public.order_items oi
  where oi.order_id = p_order_id;

  v_processing_cost := coalesce(v_order.processing_cost, 0)::numeric(12,2);
  v_shipping_amount := coalesce(v_order.shipping_amount, 0)::numeric(12,2);

  -- IMPORTANT: shipping_amount is part of the customer-facing order total and
  -- must be included in the Stripe amount validation.
  v_expected_total := round(
      v_item_total
    + v_processing_cost
    + v_shipping_amount,
    2
  );

  if round(p_amount_paid, 2) <> v_expected_total then
    raise exception 'Stripe payment amount (%) does not match order total (%).',
      to_char(round(p_amount_paid, 2), 'FM999999990.00'),
      to_char(v_expected_total, 'FM999999990.00');
  end if;

  -- Stripe retries webhook deliveries. Treat a matching payment already saved
  -- on the order as success so retries are harmless.
  if v_order.payment_status = 'paid'
     and round(coalesce(v_order.amount_paid, 0), 2) = v_expected_total
     and (v_order.payment_session_id is null or v_order.payment_session_id = p_session_id)
     and (
       p_payment_intent_id is null
       or v_order.payment_transaction_id is null
       or v_order.payment_transaction_id = p_payment_intent_id
     ) then
    v_already_processed := true;
  else
    update public.orders
       set payment_status = 'paid',
           amount_paid = v_expected_total,
           payment_provider = 'stripe',
           payment_method = 'card',
           payment_session_id = p_session_id,
           payment_transaction_id = coalesce(p_payment_intent_id, payment_transaction_id)
     where id = p_order_id;
  end if;

  return jsonb_build_object(
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'store_order_number', v_order.store_order_number,
    'amount_paid', v_expected_total,
    'item_total', v_item_total,
    'processing_cost', v_processing_cost,
    'shipping_amount', v_shipping_amount,
    'stripe_session_id', p_session_id,
    'stripe_payment_intent_id', p_payment_intent_id,
    'event_created_at', p_event_created_at,
    'already_processed', v_already_processed
  );
end;
$function$;

revoke all on function public.confirm_storefront_stripe_payment(uuid, text, text, numeric, timestamptz) from public;
revoke all on function public.confirm_storefront_stripe_payment(uuid, text, text, numeric, timestamptz) from anon;
revoke all on function public.confirm_storefront_stripe_payment(uuid, text, text, numeric, timestamptz) from authenticated;
grant execute on function public.confirm_storefront_stripe_payment(uuid, text, text, numeric, timestamptz) to service_role;

comment on function public.confirm_storefront_stripe_payment(uuid, text, text, numeric, timestamptz) is
  'Confirms a paid Stripe Checkout session after validating item total + processing cost + shipping amount. Idempotent for Stripe webhook retries.';

commit;
