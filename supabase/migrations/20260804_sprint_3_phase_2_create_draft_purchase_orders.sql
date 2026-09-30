-- Friends of 323 Coffee Portal
-- Sprint 3, Phase 2: Create Draft Purchase Orders
-- Version 1.3.1
--
-- Run after the Sprint 3 Phase 1 migration.

begin;

create or replace function public.create_draft_purchase_order(
  p_supplier_name text,
  p_lines jsonb,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_purchase_order_id uuid;
  v_line jsonb;
  v_order_item_id uuid;
  v_quantity integer;
  v_ready record;
  v_po_item_id uuid;
  v_grind public.coffee_grind;
  v_selected_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.';
  end if;

  if not public.has_any_role(array['coffee_bean']::public.app_role[]) then
    raise exception 'Only Coffee Beans can create purchase orders.';
  end if;

  if nullif(trim(coalesce(p_supplier_name, '')), '') is null then
    raise exception 'Supplier name is required.';
  end if;

  if p_lines is null
     or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'Select at least one ready-to-order line.';
  end if;

  insert into public.purchase_orders (
    supplier_name,
    status,
    order_date,
    notes,
    created_by,
    updated_by
  )
  values (
    trim(p_supplier_name),
    'draft',
    current_date,
    nullif(trim(coalesce(p_notes, '')), ''),
    v_user_id,
    v_user_id
  )
  returning id into v_purchase_order_id;

  for v_line in
    select value from jsonb_array_elements(p_lines)
  loop
    v_order_item_id := nullif(v_line->>'order_item_id', '')::uuid;
    v_quantity := coalesce(nullif(v_line->>'quantity', '')::integer, 0);

    if v_order_item_id is null or v_quantity <= 0 then
      raise exception 'Every selected line requires a valid order item and quantity.';
    end if;

    select *
    into v_ready
    from public.ready_to_order_items
    where order_item_id = v_order_item_id
    for update;

    if not found then
      raise exception
        'Order item % is no longer available to order.',
        v_order_item_id;
    end if;

    if lower(trim(v_ready.supplier_name)) <> lower(trim(p_supplier_name)) then
      raise exception
        'All selected lines must belong to supplier %.',
        p_supplier_name;
    end if;

    if v_quantity > v_ready.quantity_available then
      raise exception
        'Selected quantity % exceeds available quantity % for order item %.',
        v_quantity,
        v_ready.quantity_available,
        v_order_item_id;
    end if;

    v_grind := v_ready.grind;

    select id
    into v_po_item_id
    from public.purchase_order_items
    where purchase_order_id = v_purchase_order_id
      and product_id = v_ready.product_id
      and grind = v_grind;

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
        v_purchase_order_id,
        v_ready.product_id,
        v_ready.supplier_product_name,
        v_ready.portal_product_name,
        v_ready.sku,
        v_ready.bag_size,
        v_grind,
        0,
        v_quantity,
        0,
        v_user_id,
        v_user_id
      )
      returning id into v_po_item_id;
    else
      update public.purchase_order_items
      set quantity_ordered = quantity_ordered + v_quantity,
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
      v_order_item_id,
      v_quantity,
      v_user_id,
      v_user_id
    );

    v_selected_count := v_selected_count + 1;
  end loop;

  if v_selected_count = 0 then
    raise exception 'No purchase-order lines were created.';
  end if;

  return v_purchase_order_id;
exception
  when others then
    raise;
end;
$$;

revoke all on function public.create_draft_purchase_order(text, jsonb, text)
from public;

grant execute on function public.create_draft_purchase_order(text, jsonb, text)
to authenticated;

create or replace view public.purchase_order_allocation_detail
with (security_invoker = true)
as
select
  a.id as allocation_id,
  a.purchase_order_item_id,
  poi.purchase_order_id,
  po.po_number,
  a.order_item_id,
  a.quantity_allocated,
  o.id as order_id,
  o.order_number,
  o.ecwid_order_number,
  o.order_date,
  c.id as customer_id,
  coalesce(
    nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''),
    c.company_name,
    'Unnamed Customer'
  ) as customer_name,
  s.id as scout_id,
  case
    when s.is_general_fund then 'General Fund'
    else trim(concat_ws(' ', s.first_name, s.last_name))
  end as scout_name,
  p.id as product_id,
  p.product_name as portal_product_name,
  p.supplier_name,
  coalesce(nullif(trim(p.supplier_product_name), ''), p.product_name)
    as supplier_product_name,
  p.sku,
  p.bag_size,
  poi.grind,
  oi.notes
from public.purchase_order_allocations a
join public.purchase_order_items poi
  on poi.id = a.purchase_order_item_id
join public.purchase_orders po
  on po.id = poi.purchase_order_id
join public.order_items oi
  on oi.id = a.order_item_id
join public.orders o
  on o.id = oi.order_id
join public.customers c
  on c.id = o.customer_id
join public.scouts s
  on s.id = oi.scout_id
join public.products p
  on p.id = oi.product_id;

grant select on public.purchase_order_allocation_detail to authenticated;

commit;

-- Verification
select
  routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name = 'create_draft_purchase_order';

select
  table_name
from information_schema.views
where table_schema = 'public'
  and table_name = 'purchase_order_allocation_detail';
