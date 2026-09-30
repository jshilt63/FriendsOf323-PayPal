-- Friends of 323 Coffee Portal
-- Order-item receiving + purchase-order synchronization
-- 2026-08-13

begin;

alter table public.order_items
  add column if not exists quantity_received integer not null default 0;

alter table public.order_items
  drop constraint if exists order_items_quantity_received_check;

alter table public.order_items
  add constraint order_items_quantity_received_check
  check (quantity_received >= 0 and quantity_received <= quantity);

-- Backfill orders already marked fully received.
update public.order_items oi
set quantity_received = oi.quantity
from public.orders o
where o.id = oi.order_id
  and o.wholesaler_status = 'received'
  and oi.quantity_received <> oi.quantity;

create or replace function public.transition_purchase_order(
  p_purchase_order_id uuid,
  p_status public.purchase_order_status
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_current_status public.purchase_order_status;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.';
  end if;

  if not public.has_any_role(array['coffee_bean']::public.app_role[]) then
    raise exception 'Only Coffee Beans can update purchase-order status.';
  end if;

  select status into v_current_status
  from public.purchase_orders
  where id = p_purchase_order_id
  for update;

  if not found then
    raise exception 'Purchase order not found.';
  end if;

  if p_status = 'submitted' then
    if v_current_status <> 'draft' then
      raise exception 'Only a draft purchase order can be submitted.';
    end if;

    update public.purchase_orders
    set status = 'submitted', updated_by = v_user_id
    where id = p_purchase_order_id;

    -- Submitting a supplier PO means every customer order represented on that
    -- PO has left Ready to Order and is now being processed by a roaster.
    -- The customer order remains at Roaster Processing until all of its
    -- individual order-item quantities have been received.
    with affected_orders as (
      select distinct oi.order_id
      from public.purchase_order_allocations a
      join public.purchase_order_items poi on poi.id = a.purchase_order_item_id
      join public.order_items oi on oi.id = a.order_item_id
      where poi.purchase_order_id = p_purchase_order_id
    )
    update public.orders o
    set wholesaler_status = 'submitted',
        updated_by = v_user_id
    from affected_orders ao
    where o.id = ao.order_id
      and o.wholesaler_status in ('not_ready', 'ready_to_submit');

  elsif p_status = 'received' then
    if v_current_status not in ('submitted', 'partially_received') then
      raise exception 'Only a submitted purchase order can be marked received.';
    end if;

    update public.purchase_order_items
    set quantity_received = quantity_ordered, updated_by = v_user_id
    where purchase_order_id = p_purchase_order_id;

    -- Every customer-order allocation on this PO is now physically received.
    -- Cap at the customer order quantity in case the same line was split across POs.
    with received_allocations as (
      select a.order_item_id, sum(a.quantity_allocated)::integer as qty
      from public.purchase_order_allocations a
      join public.purchase_order_items poi on poi.id = a.purchase_order_item_id
      where poi.purchase_order_id = p_purchase_order_id
      group by a.order_item_id
    )
    update public.order_items oi
    set quantity_received = least(oi.quantity, oi.quantity_received + ra.qty),
        updated_by = v_user_id
    from received_allocations ra
    where oi.id = ra.order_item_id;

    update public.purchase_orders
    set status = 'received', updated_by = v_user_id
    where id = p_purchase_order_id;

    -- Roll the parent customer order up from line-level receipt quantities.
    with affected_orders as (
      select distinct oi.order_id
      from public.purchase_order_allocations a
      join public.purchase_order_items poi on poi.id = a.purchase_order_item_id
      join public.order_items oi on oi.id = a.order_item_id
      where poi.purchase_order_id = p_purchase_order_id
    ), receipt_totals as (
      select oi.order_id,
             sum(oi.quantity)::integer as ordered_qty,
             sum(oi.quantity_received)::integer as received_qty
      from public.order_items oi
      join affected_orders ao on ao.order_id = oi.order_id
      group by oi.order_id
    )
    update public.orders o
    set wholesaler_status = case
          when rt.received_qty >= rt.ordered_qty then 'received'
          when rt.received_qty > 0 then 'in_process'
          else o.wholesaler_status
        end,
        updated_by = v_user_id
    from receipt_totals rt
    where o.id = rt.order_id;

  else
    raise exception 'Unsupported purchase-order status transition.';
  end if;
end;
$$;

revoke execute on function public.transition_purchase_order(uuid, public.purchase_order_status)
  from public, anon, authenticated;
grant execute on function public.transition_purchase_order(uuid, public.purchase_order_status)
  to authenticated;

commit;
