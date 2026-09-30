-- Friends of 323 Coffee Portal
-- Edit draft purchase orders: selective add/remove and empty draft support
-- 2026-08-28

begin;

create or replace function public.add_lines_to_draft_purchase_order(
  p_purchase_order_id uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_po public.purchase_orders%rowtype;
  v_line jsonb;
  v_ready record;
  v_order_item_id uuid;
  v_quantity integer;
  v_po_item_id uuid;
  v_added integer := 0;
begin
  if v_user_id is null then raise exception 'Authentication is required.'; end if;
  if not public.has_any_role(array['coffee_bean']::public.app_role[]) then
    raise exception 'Only Coffee Beans can edit draft purchase orders.';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Select at least one ready-to-order line.';
  end if;

  select * into v_po from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then raise exception 'Purchase order not found.'; end if;
  if v_po.status <> 'draft' then raise exception 'Only a draft purchase order can be edited.'; end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_order_item_id := nullif(v_line->>'order_item_id','')::uuid;
    v_quantity := coalesce(nullif(v_line->>'quantity','')::integer,0);
    if v_order_item_id is null or v_quantity <= 0 then
      raise exception 'Every selected line requires a valid order item and quantity.';
    end if;

    select * into v_ready
    from public.ready_to_order_items
    where order_item_id = v_order_item_id
    for update;
    if not found then raise exception 'Order item % is no longer available to order.', v_order_item_id; end if;
    if lower(trim(v_ready.supplier_name)) <> lower(trim(v_po.supplier_name)) then
      raise exception 'Selected bag belongs to a different supplier.';
    end if;
    if v_quantity > v_ready.quantity_available then
      raise exception 'Selected quantity % exceeds available quantity %.', v_quantity, v_ready.quantity_available;
    end if;

    select id into v_po_item_id
    from public.purchase_order_items
    where purchase_order_id = p_purchase_order_id
      and product_id = v_ready.product_id
      and grind = v_ready.grind
    for update;

    if v_po_item_id is null then
      insert into public.purchase_order_items(
        purchase_order_id,product_id,supplier_product_name,portal_product_name,sku,bag_size,grind,
        unit_cost,quantity_ordered,quantity_received,created_by,updated_by
      ) values(
        p_purchase_order_id,v_ready.product_id,v_ready.supplier_product_name,v_ready.portal_product_name,
        v_ready.sku,v_ready.bag_size,v_ready.grind,0,v_quantity,0,v_user_id,v_user_id
      ) returning id into v_po_item_id;
    else
      update public.purchase_order_items
      set quantity_ordered = quantity_ordered + v_quantity, updated_by = v_user_id
      where id = v_po_item_id;
    end if;

    insert into public.purchase_order_allocations(
      purchase_order_item_id,order_item_id,quantity_allocated,created_by,updated_by
    ) values(v_po_item_id,v_order_item_id,v_quantity,v_user_id,v_user_id)
    on conflict (purchase_order_item_id,order_item_id)
    do update set quantity_allocated = public.purchase_order_allocations.quantity_allocated + excluded.quantity_allocated,
                  updated_by = v_user_id;

    v_added := v_added + v_quantity;
  end loop;

  update public.purchase_orders set updated_by = v_user_id where id = p_purchase_order_id;
  return jsonb_build_object('purchase_order_id',p_purchase_order_id,'bags_added',v_added);
end;
$function$;

revoke all on function public.add_lines_to_draft_purchase_order(uuid,jsonb) from public, anon;
grant execute on function public.add_lines_to_draft_purchase_order(uuid,jsonb) to authenticated;

create or replace function public.remove_draft_purchase_order_allocation(
  p_allocation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_alloc public.purchase_order_allocations%rowtype;
  v_item public.purchase_order_items%rowtype;
  v_po public.purchase_orders%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication is required.'; end if;
  if not public.has_any_role(array['coffee_bean']::public.app_role[]) then
    raise exception 'Only Coffee Beans can edit draft purchase orders.';
  end if;

  select * into v_alloc from public.purchase_order_allocations where id = p_allocation_id for update;
  if not found then raise exception 'Purchase-order allocation not found.'; end if;
  select * into v_item from public.purchase_order_items where id = v_alloc.purchase_order_item_id for update;
  select * into v_po from public.purchase_orders where id = v_item.purchase_order_id for update;
  if v_po.status <> 'draft' then raise exception 'Only a draft purchase order can be edited.'; end if;
  if v_item.quantity_received > 0 then raise exception 'Received quantities cannot be removed from a draft purchase order.'; end if;

  delete from public.purchase_order_allocations where id = p_allocation_id;

  if v_item.quantity_ordered = v_alloc.quantity_allocated then
    delete from public.purchase_order_items where id = v_item.id;
  else
    update public.purchase_order_items
    set quantity_ordered = quantity_ordered - v_alloc.quantity_allocated, updated_by = v_user_id
    where id = v_item.id;
  end if;

  update public.purchase_orders set updated_by = v_user_id where id = v_po.id;
  return jsonb_build_object('purchase_order_id',v_po.id,'bags_removed',v_alloc.quantity_allocated);
end;
$function$;

revoke all on function public.remove_draft_purchase_order_allocation(uuid) from public, anon;
grant execute on function public.remove_draft_purchase_order_allocation(uuid) to authenticated;

-- Allow a draft PO shell to be created even when no bags are ready yet.
create or replace function public.create_empty_draft_purchase_order(
  p_supplier_name text,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication is required.'; end if;
  if not public.has_any_role(array['coffee_bean']::public.app_role[]) then
    raise exception 'Only Coffee Beans can create purchase orders.';
  end if;
  if nullif(trim(coalesce(p_supplier_name,'')),'') is null then raise exception 'Supplier name is required.'; end if;
  insert into public.purchase_orders(supplier_name,status,order_date,notes,created_by,updated_by)
  values(trim(p_supplier_name),'draft',current_date,nullif(trim(coalesce(p_notes,'')),''),v_user_id,v_user_id)
  returning id into v_id;
  return v_id;
end;
$function$;

revoke all on function public.create_empty_draft_purchase_order(text,text) from public, anon;
grant execute on function public.create_empty_draft_purchase_order(text,text) to authenticated;

commit;
