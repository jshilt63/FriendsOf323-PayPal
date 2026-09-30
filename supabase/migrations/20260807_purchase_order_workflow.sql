-- Friends of 323 Coffee Portal
-- Purchase-order status workflow
-- 2026-08-07
-- Adds an atomic Coffee Bean-only transition for Draft -> Submitted and
-- Submitted/Partially Received -> Received. Receiving records every line's
-- quantity_received as the full quantity_ordered before closing the PO.

begin;

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

  select status
    into v_current_status
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
       set status = 'submitted',
           updated_by = v_user_id
     where id = p_purchase_order_id;

  elsif p_status = 'received' then
    if v_current_status not in ('submitted', 'partially_received') then
      raise exception 'Only a submitted purchase order can be marked received.';
    end if;

    update public.purchase_order_items
       set quantity_received = quantity_ordered,
           updated_by = v_user_id
     where purchase_order_id = p_purchase_order_id;

    update public.purchase_orders
       set status = 'received',
           updated_by = v_user_id
     where id = p_purchase_order_id;

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
