-- Friends of 323 Coffee Portal
-- Refresh an existing DRAFT purchase order with newly eligible orders
-- 2026-08-19

begin;

create or replace function public.refresh_draft_purchase_order(
  p_purchase_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_po public.purchase_orders%rowtype;
  v_ready record;
  v_po_item_id uuid;
  v_lines_added integer := 0;
  v_bags_added integer := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.';
  end if;

  if not public.has_any_role(array['coffee_bean']::public.app_role[]) then
    raise exception 'Only Coffee Beans can refresh draft purchase orders.';
  end if;

  select *
  into v_po
  from public.purchase_orders
  where id = p_purchase_order_id
  for update;

  if not found then
    raise exception 'Purchase order not found.';
  end if;

  if v_po.status <> 'draft' then
    raise exception
      'Only a draft purchase order can be refreshed. % is currently %.',
      v_po.po_number,
      v_po.status;
  end if;

  /*
   * ready_to_order_items already represents paid customer-order
   * quantities that have not yet been allocated to any purchase order.
   *
   * Therefore:
   *   - existing allocations on this draft are preserved;
   *   - submitted/received PO allocations are never duplicated;
   *   - only newly eligible quantities for this PO's supplier are added.
   */
  for v_ready in
    select *
    from public.ready_to_order_items
    where lower(trim(supplier_name)) = lower(trim(v_po.supplier_name))
    order by supplier_product_name, grind, order_number, order_item_id
  loop

    if coalesce(v_ready.quantity_available, 0) <= 0 then
      continue;
    end if;

    /*
     * Reuse the grouped PO line when product + grind already exists.
     * Otherwise create a new supplier line.
     */
    select id
    into v_po_item_id
    from public.purchase_order_items
    where purchase_order_id = p_purchase_order_id
      and product_id = v_ready.product_id
      and grind = v_ready.grind
    for update;

    if v_po_item_id is null then
      insert into public.purchase_order_items (
        purchase_order_id,
        product_id,
        supplier_product_name,
        portal_product_name,
        sku,
        bag_size,
        grind,
        unit_cost,
        quantity_ordered,
        quantity_received,
        created_by,
        updated_by
      )
      values (
        p_purchase_order_id,
        v_ready.product_id,
        v_ready.supplier_product_name,
        v_ready.portal_product_name,
        v_ready.sku,
        v_ready.bag_size,
        v_ready.grind,
        0,
        v_ready.quantity_available,
        0,
        v_user_id,
        v_user_id
      )
      returning id into v_po_item_id;
    else
      update public.purchase_order_items
      set
        quantity_ordered = quantity_ordered + v_ready.quantity_available,
        updated_by = v_user_id
      where id = v_po_item_id;
    end if;

    insert into public.purchase_order_allocations (
      purchase_order_item_id,
      order_item_id,
      quantity_allocated,
      created_by,
      updated_by
    )
    values (
      v_po_item_id,
      v_ready.order_item_id,
      v_ready.quantity_available,
      v_user_id,
      v_user_id
    );

    v_lines_added := v_lines_added + 1;
    v_bags_added := v_bags_added + v_ready.quantity_available;

  end loop;

  update public.purchase_orders
  set updated_by = v_user_id
  where id = p_purchase_order_id;

  return jsonb_build_object(
    'purchase_order_id', p_purchase_order_id,
    'po_number', v_po.po_number,
    'supplier_name', v_po.supplier_name,
    'order_lines_added', v_lines_added,
    'bags_added', v_bags_added
  );

end;
$function$;

revoke all
on function public.refresh_draft_purchase_order(uuid)
from public;

revoke all
on function public.refresh_draft_purchase_order(uuid)
from anon;

grant execute
on function public.refresh_draft_purchase_order(uuid)
to authenticated;

commit;


-- Verification
select
  routine_name,
  security_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name = 'refresh_draft_purchase_order';
