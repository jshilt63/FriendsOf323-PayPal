-- Friends of 323 Coffee Portal
-- Manual PO lines + customer delivery sheets / fulfillment exceptions
-- 2026-08-19

begin;

create table if not exists public.purchase_order_manual_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete set null,
  recipient_name text,
  grind public.coffee_grind not null,
  quantity_ordered integer not null check (quantity_ordered > 0),
  quantity_received integer not null default 0
    check (quantity_received >= 0 and quantity_received <= quantity_ordered),
  no_charge boolean not null default false,
  unit_cost numeric(10,2) not null default 0 check (unit_cost >= 0),
  reason text not null,
  notes text,
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint manual_po_recipient_required check (
    customer_id is not null or nullif(trim(coalesce(recipient_name,'')), '') is not null
  ),
  constraint manual_po_reason_required check (
    nullif(trim(coalesce(reason,'')), '') is not null
  )
);

create index if not exists purchase_order_manual_items_po_idx
  on public.purchase_order_manual_items(purchase_order_id);
create index if not exists purchase_order_manual_items_customer_idx
  on public.purchase_order_manual_items(customer_id);

drop trigger if exists purchase_order_manual_items_set_updated_at
  on public.purchase_order_manual_items;
create trigger purchase_order_manual_items_set_updated_at
before update on public.purchase_order_manual_items
for each row execute function public.set_updated_at();

create or replace function public.prepare_purchase_order_manual_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_supplier text;
begin
  select * into v_product from public.products where id = new.product_id;
  if not found then raise exception 'Product not found.'; end if;

  select supplier_name into v_supplier
  from public.purchase_orders where id = new.purchase_order_id;
  if not found then raise exception 'Purchase order not found.'; end if;

  if lower(trim(coalesce(v_product.supplier_name,''))) <> lower(trim(coalesce(v_supplier,''))) then
    raise exception 'Product supplier (%) does not match purchase order supplier (%).',
      v_product.supplier_name, v_supplier;
  end if;

  if new.no_charge then
    new.unit_cost := 0;
  elsif new.unit_cost is null or new.unit_cost = 0 then
    new.unit_cost := coalesce(v_product.cost, 0);
  end if;

  return new;
end;
$$;

drop trigger if exists purchase_order_manual_items_prepare
  on public.purchase_order_manual_items;
create trigger purchase_order_manual_items_prepare
before insert or update of product_id, purchase_order_id, no_charge
on public.purchase_order_manual_items
for each row execute function public.prepare_purchase_order_manual_item();

create table if not exists public.customer_fulfillment_exceptions (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  reason text not null,
  notes text,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fulfillment_exception_reason_required check (
    nullif(trim(coalesce(reason,'')), '') is not null
  )
);

create index if not exists customer_fulfillment_exceptions_item_idx
  on public.customer_fulfillment_exceptions(order_item_id);
create index if not exists customer_fulfillment_exceptions_open_idx
  on public.customer_fulfillment_exceptions(order_item_id)
  where resolved_at is null;

drop trigger if exists customer_fulfillment_exceptions_set_updated_at
  on public.customer_fulfillment_exceptions;
create trigger customer_fulfillment_exceptions_set_updated_at
before update on public.customer_fulfillment_exceptions
for each row execute function public.set_updated_at();

-- Manual line detail for the PO screen and printed PO.
create or replace view public.purchase_order_manual_item_detail
with (security_invoker = true)
as
select
  mi.id,
  mi.purchase_order_id,
  po.po_number,
  po.supplier_name,
  po.status,
  mi.product_id,
  p.product_name as portal_product_name,
  coalesce(nullif(trim(p.supplier_product_name),''), p.product_name) as supplier_product_name,
  p.sku,
  p.bag_size,
  mi.grind,
  mi.quantity_ordered,
  mi.quantity_received,
  mi.no_charge,
  mi.unit_cost,
  (mi.quantity_ordered * mi.unit_cost)::numeric(12,2) as extended_cost,
  mi.customer_id,
  coalesce(
    nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''),
    c.company_name,
    nullif(trim(mi.recipient_name),''),
    'Unspecified Recipient'
  ) as recipient_name,
  mi.reason,
  mi.notes,
  mi.created_at
from public.purchase_order_manual_items mi
join public.purchase_orders po on po.id = mi.purchase_order_id
join public.products p on p.id = mi.product_id
left join public.customers c on c.id = mi.customer_id;

-- Delivery detail for normal customer-order items. An item is available for
-- delivery only to the extent that its active PO allocations have been received.
create or replace view public.customer_delivery_item_detail
with (security_invoker = true)
as
with received_allocations as (
  select
    a.order_item_id,
    coalesce(sum(
      case
        when po.status = 'received' then a.quantity_allocated
        else 0
      end
    ),0)::integer as quantity_po_received
  from public.purchase_order_allocations a
  join public.purchase_order_items poi on poi.id = a.purchase_order_item_id
  join public.purchase_orders po on po.id = poi.purchase_order_id
  where po.status <> 'cancelled'
  group by a.order_item_id
),
open_exceptions as (
  select
    order_item_id,
    coalesce(sum(quantity),0)::integer as exception_quantity,
    string_agg(distinct reason, ', ' order by reason) as exception_reasons
  from public.customer_fulfillment_exceptions
  where resolved_at is null
  group by order_item_id
)
select
  o.id as order_id,
  o.order_number,
  o.store_order_number,
  o.ecwid_order_number,
  o.order_date,
  o.delivery_status,
  o.payment_status,
  c.id as customer_id,
  coalesce(nullif(trim(concat_ws(' ',c.first_name,c.last_name)),''), c.company_name, 'Unnamed Customer') as customer_name,
  c.address_line_1,
  c.address_line_2,
  c.city,
  c.state,
  c.postal_code,
  c.email,
  c.phone,
  oi.id as order_item_id,
  p.product_name,
  p.bag_size,
  case when lower(coalesce(oi.notes,'')) like '%whole bean%' then 'Whole Bean' else 'Ground' end as grind_label,
  oi.quantity as quantity_ordered,
  least(oi.quantity, coalesce(ra.quantity_po_received,0)) as quantity_roaster_received,
  least(
    least(oi.quantity, coalesce(ra.quantity_po_received,0)),
    coalesce(oe.exception_quantity,0)
  ) as quantity_held,
  greatest(
    least(oi.quantity, coalesce(ra.quantity_po_received,0))
      - coalesce(oe.exception_quantity,0),
    0
  )::integer as quantity_delivering,
  greatest(
    oi.quantity
      - greatest(
          least(oi.quantity, coalesce(ra.quantity_po_received,0))
            - coalesce(oe.exception_quantity,0),
          0
        ),
    0
  )::integer as quantity_outstanding,
  oe.exception_reasons
from public.order_items oi
join public.orders o on o.id = oi.order_id
join public.customers c on c.id = o.customer_id
join public.products p on p.id = oi.product_id
left join received_allocations ra on ra.order_item_id = oi.id
left join open_exceptions oe on oe.order_item_id = oi.id
where o.record_status = 'active'
  and o.delivery_status <> 'delivered';

alter table public.purchase_order_manual_items enable row level security;
alter table public.customer_fulfillment_exceptions enable row level security;

drop policy if exists purchase_order_manual_items_read on public.purchase_order_manual_items;
create policy purchase_order_manual_items_read
on public.purchase_order_manual_items for select to authenticated
using (public.is_active_user());

drop policy if exists purchase_order_manual_items_write on public.purchase_order_manual_items;
create policy purchase_order_manual_items_write
on public.purchase_order_manual_items for all to authenticated
using (public.has_any_role(array['coffee_bean']::public.app_role[]))
with check (
  public.has_any_role(array['coffee_bean']::public.app_role[])
  and created_by = coalesce(created_by, (select auth.uid()))
);

drop policy if exists fulfillment_exceptions_read on public.customer_fulfillment_exceptions;
create policy fulfillment_exceptions_read
on public.customer_fulfillment_exceptions for select to authenticated
using (public.is_active_user());

drop policy if exists fulfillment_exceptions_write on public.customer_fulfillment_exceptions;
create policy fulfillment_exceptions_write
on public.customer_fulfillment_exceptions for all to authenticated
using (public.has_any_role(array['coffee_bean']::public.app_role[]))
with check (public.has_any_role(array['coffee_bean']::public.app_role[]));

grant select on public.purchase_order_manual_items,
  public.customer_fulfillment_exceptions to authenticated;
grant insert, update, delete on public.purchase_order_manual_items,
  public.customer_fulfillment_exceptions to authenticated;
grant select on public.purchase_order_manual_item_detail,
  public.customer_delivery_item_detail to authenticated;

-- Extend PO receiving so manual lines are received with normal lines.
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
  if v_user_id is null then raise exception 'Authentication is required.'; end if;
  if not public.has_any_role(array['coffee_bean']::public.app_role[]) then
    raise exception 'Only Coffee Beans can update purchase-order status.';
  end if;

  select status into v_current_status
  from public.purchase_orders
  where id = p_purchase_order_id
  for update;

  if not found then raise exception 'Purchase order not found.'; end if;

  if p_status = 'submitted' then
    if v_current_status <> 'draft' then
      raise exception 'Only a draft purchase order can be submitted.';
    end if;
    update public.purchase_orders
      set status='submitted', updated_by=v_user_id
      where id=p_purchase_order_id;

  elsif p_status = 'received' then
    if v_current_status not in ('submitted','partially_received') then
      raise exception 'Only a submitted purchase order can be marked received.';
    end if;

    update public.purchase_order_items
      set quantity_received=quantity_ordered, updated_by=v_user_id
      where purchase_order_id=p_purchase_order_id;

    update public.purchase_order_manual_items
      set quantity_received=quantity_ordered, updated_by=v_user_id
      where purchase_order_id=p_purchase_order_id;

    update public.purchase_orders
      set status='received', updated_by=v_user_id
      where id=p_purchase_order_id;
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

-- Verification
select table_name
from information_schema.tables
where table_schema='public'
  and table_name in ('purchase_order_manual_items','customer_fulfillment_exceptions')
order by table_name;
