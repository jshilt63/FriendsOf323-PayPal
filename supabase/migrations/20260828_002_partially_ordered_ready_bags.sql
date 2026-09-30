-- Friends of 323 Coffee Portal
-- Keep remaining unallocated bags eligible when a customer order is partially ordered.
-- 2026-08-28

begin;

create or replace view public.ready_to_order_items
with (security_invoker = true)
as
with allocated as (
  select
    a.order_item_id,
    coalesce(sum(a.quantity_allocated), 0)::integer as allocated_quantity
  from public.purchase_order_allocations a
  join public.purchase_order_items poi
    on poi.id = a.purchase_order_item_id
  join public.purchase_orders po
    on po.id = poi.purchase_order_id
  where po.status <> 'cancelled'
  group by a.order_item_id
)
select
  oi.id as order_item_id,
  oi.order_id,
  o.order_number,
  o.ecwid_order_number,
  o.order_date,
  o.customer_id,
  c.first_name as customer_first_name,
  c.last_name as customer_last_name,
  c.company_name as customer_company_name,
  oi.product_id,
  p.sku,
  p.product_name as portal_product_name,
  p.supplier_name,
  coalesce(
    nullif(trim(p.supplier_product_name), ''),
    p.product_name
  ) as supplier_product_name,
  p.bag_size,
  case
    when lower(coalesce(oi.notes, '')) like '%whole bean%'
      then 'whole_bean'::public.coffee_grind
    else 'ground'::public.coffee_grind
  end as grind,
  oi.scout_id,
  s.first_name as scout_first_name,
  s.last_name as scout_last_name,
  s.is_general_fund,
  oi.quantity,
  coalesce(a.allocated_quantity, 0) as quantity_allocated,
  oi.quantity - coalesce(a.allocated_quantity, 0) as quantity_available,
  oi.notes
from public.order_items oi
join public.orders o
  on o.id = oi.order_id
join public.customers c
  on c.id = o.customer_id
join public.products p
  on p.id = oi.product_id
join public.scouts s
  on s.id = oi.scout_id
left join allocated a
  on a.order_item_id = oi.id
where o.record_status = 'active'
  and o.payment_status = 'paid'
  and o.delivery_status <> 'delivered'
  and o.wholesaler_status in ('not_ready', 'ready_to_submit', 'partially_ordered')
  and oi.quantity - coalesce(a.allocated_quantity, 0) > 0;

commit;

-- Verification: partially ordered customer orders with unallocated bags
-- should now appear here, grouped with all other ready quantities.
select
  wholesaler_status,
  count(*) as orders_with_available_bags
from public.orders o
where o.id in (select distinct order_id from public.ready_to_order_items)
group by wholesaler_status
order by wholesaler_status;
