-- Friends of 323 Coffee Portal
-- Purchase-order summary: include manual PO lines
-- 2026-08-27
--
-- Fixes the Purchase Orders list/cards so Bags, Cost, and Lines match
-- the detailed PO when purchase_order_manual_items are present.
--
-- Example PO-2026-0007:
--   Normal items: 11 bags / $140 / 6 lines
--   Manual items:  1 bag  / $14  / 1 line
--   Summary:      12 bags / $154 / 7 lines

begin;

create or replace view public.purchase_order_summary
with (security_invoker = true)
as
with normal_totals as (
  select
    poi.purchase_order_id,
    coalesce(sum(poi.quantity_ordered), 0)::bigint as bags_ordered,
    coalesce(sum(poi.quantity_received), 0)::bigint as bags_received,
    coalesce(sum(poi.quantity_ordered * poi.unit_cost), 0)::numeric(12,2) as total_cost,
    count(poi.id)::bigint as line_count
  from public.purchase_order_items poi
  group by poi.purchase_order_id
),
manual_totals as (
  select
    mi.purchase_order_id,
    coalesce(sum(mi.quantity_ordered), 0)::bigint as bags_ordered,
    coalesce(sum(mi.quantity_received), 0)::bigint as bags_received,
    coalesce(sum(mi.quantity_ordered * mi.unit_cost), 0)::numeric(12,2) as total_cost,
    count(mi.id)::bigint as line_count
  from public.purchase_order_manual_items mi
  group by mi.purchase_order_id
)
select
  po.id,
  po.po_number,
  po.supplier_name,
  po.status,
  po.order_date,
  po.submitted_at,
  po.received_at,
  po.cancelled_at,
  po.notes,
  (
    coalesce(nt.bags_ordered, 0)
    + coalesce(mt.bags_ordered, 0)
  )::bigint as total_bags_ordered,
  (
    coalesce(nt.bags_received, 0)
    + coalesce(mt.bags_received, 0)
  )::bigint as total_bags_received,
  (
    coalesce(nt.total_cost, 0)
    + coalesce(mt.total_cost, 0)
  )::numeric(12,2) as total_cost,
  (
    coalesce(nt.line_count, 0)
    + coalesce(mt.line_count, 0)
  )::bigint as product_lines,
  po.created_by,
  po.updated_by,
  po.created_at,
  po.updated_at
from public.purchase_orders po
left join normal_totals nt
  on nt.purchase_order_id = po.id
left join manual_totals mt
  on mt.purchase_order_id = po.id;

grant select on public.purchase_order_summary to authenticated;

commit;

-- Verification
select
  po_number,
  total_bags_ordered,
  product_lines,
  total_cost
from public.purchase_order_summary
where po_number = 'PO-2026-0007';
