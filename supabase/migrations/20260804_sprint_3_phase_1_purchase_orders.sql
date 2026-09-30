-- Friends of 323 Coffee Portal
-- Sprint 3, Phase 1: Purchase Order Management foundation
-- Version 1.3.0
--
-- Run once in Supabase Dashboard > SQL Editor.
-- This migration creates first-class purchase-order records, item allocations,
-- audit coverage, role-based access, and a ready-to-order view.
--
-- Grind is intentionally limited to Whole Bean and Ground.

begin;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

do $$
begin
  create type public.purchase_order_status as enum (
    'draft',
    'submitted',
    'partially_received',
    'received',
    'cancelled'
  );
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.coffee_grind as enum (
    'whole_bean',
    'ground'
  );
exception
  when duplicate_object then null;
end
$$;

-- ---------------------------------------------------------------------------
-- Numbering
-- ---------------------------------------------------------------------------

create sequence if not exists public.purchase_order_number_seq start with 1;

create or replace function public.assign_purchase_order_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if nullif(trim(coalesce(new.po_number, '')), '') is null then
    new.po_number :=
      'PO-' ||
      to_char(coalesce(new.created_at, now()), 'YYYY') ||
      '-' ||
      lpad(nextval('public.purchase_order_number_seq')::text, 4, '0');
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_number text not null unique,
  supplier_name text not null,
  status public.purchase_order_status not null default 'draft',
  order_date date not null default current_date,
  submitted_at timestamptz,
  received_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  notes text,
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint purchase_orders_supplier_required
    check (length(trim(supplier_name)) > 0),

  constraint purchase_orders_cancel_reason
    check (
      status <> 'cancelled'
      or nullif(trim(coalesce(cancellation_reason, '')), '') is not null
    ),

  constraint purchase_orders_status_dates
    check (
      (status = 'draft'
        and submitted_at is null
        and received_at is null
        and cancelled_at is null)
      or
      (status in ('submitted', 'partially_received')
        and submitted_at is not null
        and received_at is null
        and cancelled_at is null)
      or
      (status = 'received'
        and submitted_at is not null
        and received_at is not null
        and cancelled_at is null)
      or
      (status = 'cancelled'
        and cancelled_at is not null)
    )
);

create index if not exists purchase_orders_status_date_idx
  on public.purchase_orders(status, order_date desc);

create index if not exists purchase_orders_supplier_date_idx
  on public.purchase_orders(lower(supplier_name), order_date desc);

drop trigger if exists purchase_orders_assign_number on public.purchase_orders;
create trigger purchase_orders_assign_number
before insert on public.purchase_orders
for each row execute function public.assign_purchase_order_number();

drop trigger if exists purchase_orders_set_updated_at on public.purchase_orders;
create trigger purchase_orders_set_updated_at
before update on public.purchase_orders
for each row execute function public.set_updated_at();

create or replace function public.prepare_purchase_order_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'draft' then
      new.submitted_at := null;
      new.received_at := null;
      new.cancelled_at := null;
      new.cancellation_reason := null;

    elsif new.status = 'submitted' then
      new.submitted_at := coalesce(new.submitted_at, now());
      new.received_at := null;
      new.cancelled_at := null;
      new.cancellation_reason := null;

    elsif new.status = 'partially_received' then
      new.submitted_at := coalesce(new.submitted_at, old.submitted_at, now());
      new.received_at := null;
      new.cancelled_at := null;
      new.cancellation_reason := null;

    elsif new.status = 'received' then
      new.submitted_at := coalesce(new.submitted_at, old.submitted_at, now());
      new.received_at := coalesce(new.received_at, now());
      new.cancelled_at := null;
      new.cancellation_reason := null;

    elsif new.status = 'cancelled' then
      new.cancelled_at := coalesce(new.cancelled_at, now());
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists purchase_orders_prepare_status on public.purchase_orders;
create trigger purchase_orders_prepare_status
before update of status on public.purchase_orders
for each row execute function public.prepare_purchase_order_status();

-- ---------------------------------------------------------------------------
-- Purchase-order items
-- ---------------------------------------------------------------------------

create table if not exists public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null
    references public.purchase_orders(id) on delete cascade,
  product_id uuid not null
    references public.products(id) on delete restrict,

  -- Snapshots preserve what was actually ordered even if product data changes.
  supplier_product_name text not null,
  portal_product_name text not null,
  sku text not null,
  bag_size public.bag_size not null,
  grind public.coffee_grind not null,
  unit_cost numeric(10,2) not null default 0 check (unit_cost >= 0),

  quantity_ordered integer not null check (quantity_ordered > 0),
  quantity_received integer not null default 0
    check (quantity_received >= 0 and quantity_received <= quantity_ordered),

  notes text,
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint purchase_order_items_supplier_product_required
    check (length(trim(supplier_product_name)) > 0),

  constraint purchase_order_items_portal_product_required
    check (length(trim(portal_product_name)) > 0),

  constraint purchase_order_items_sku_required
    check (length(trim(sku)) > 0),

  constraint purchase_order_items_group_unique
    unique (purchase_order_id, product_id, grind)
);

create index if not exists purchase_order_items_po_idx
  on public.purchase_order_items(purchase_order_id);

create index if not exists purchase_order_items_product_idx
  on public.purchase_order_items(product_id);

drop trigger if exists purchase_order_items_set_updated_at
  on public.purchase_order_items;
create trigger purchase_order_items_set_updated_at
before update on public.purchase_order_items
for each row execute function public.set_updated_at();

create or replace function public.prepare_purchase_order_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  product_row public.products%rowtype;
  order_supplier text;
begin
  select *
  into product_row
  from public.products
  where id = new.product_id;

  if not found then
    raise exception 'Product not found.';
  end if;

  select supplier_name
  into order_supplier
  from public.purchase_orders
  where id = new.purchase_order_id;

  if not found then
    raise exception 'Purchase order not found.';
  end if;

  if nullif(trim(coalesce(product_row.supplier_name, '')), '') is null then
    raise exception 'Product % is missing a supplier name.', product_row.product_name;
  end if;

  if lower(trim(order_supplier)) <> lower(trim(product_row.supplier_name)) then
    raise exception
      'Product supplier (%) does not match purchase order supplier (%).',
      product_row.supplier_name,
      order_supplier;
  end if;

  new.supplier_product_name :=
    coalesce(
      nullif(trim(product_row.supplier_product_name), ''),
      product_row.product_name
    );
  new.portal_product_name := product_row.product_name;
  new.sku := product_row.sku;
  new.bag_size := product_row.bag_size;
  new.unit_cost := product_row.cost;

  return new;
end;
$$;

drop trigger if exists purchase_order_items_prepare
  on public.purchase_order_items;
create trigger purchase_order_items_prepare
before insert or update of product_id, purchase_order_id
on public.purchase_order_items
for each row execute function public.prepare_purchase_order_item();

-- ---------------------------------------------------------------------------
-- Allocation bridge: customer order items -> purchase-order items
-- ---------------------------------------------------------------------------

create table if not exists public.purchase_order_allocations (
  id uuid primary key default gen_random_uuid(),
  purchase_order_item_id uuid not null
    references public.purchase_order_items(id) on delete cascade,
  order_item_id uuid not null
    references public.order_items(id) on delete restrict,
  quantity_allocated integer not null check (quantity_allocated > 0),
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint purchase_order_allocations_unique
    unique (purchase_order_item_id, order_item_id)
);

create index if not exists purchase_order_allocations_po_item_idx
  on public.purchase_order_allocations(purchase_order_item_id);

create index if not exists purchase_order_allocations_order_item_idx
  on public.purchase_order_allocations(order_item_id);

drop trigger if exists purchase_order_allocations_set_updated_at
  on public.purchase_order_allocations;
create trigger purchase_order_allocations_set_updated_at
before update on public.purchase_order_allocations
for each row execute function public.set_updated_at();

create or replace function public.validate_purchase_order_allocation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_item public.order_items%rowtype;
  po_product_id uuid;
  other_allocated integer;
begin
  select *
  into source_item
  from public.order_items
  where id = new.order_item_id;

  if not found then
    raise exception 'Customer order item not found.';
  end if;

  select product_id
  into po_product_id
  from public.purchase_order_items
  where id = new.purchase_order_item_id;

  if not found then
    raise exception 'Purchase-order item not found.';
  end if;

  if source_item.product_id <> po_product_id then
    raise exception
      'Purchase-order item and customer order item must reference the same product.';
  end if;

  select coalesce(sum(a.quantity_allocated), 0)
  into other_allocated
  from public.purchase_order_allocations a
  join public.purchase_order_items poi
    on poi.id = a.purchase_order_item_id
  join public.purchase_orders po
    on po.id = poi.purchase_order_id
  where a.order_item_id = new.order_item_id
    and a.id is distinct from new.id
    and po.status <> 'cancelled';

  if other_allocated + new.quantity_allocated > source_item.quantity then
    raise exception
      'Allocated quantity (%) exceeds customer order quantity (%).',
      other_allocated + new.quantity_allocated,
      source_item.quantity;
  end if;

  return new;
end;
$$;

drop trigger if exists purchase_order_allocations_validate
  on public.purchase_order_allocations;
create trigger purchase_order_allocations_validate
before insert or update
on public.purchase_order_allocations
for each row execute function public.validate_purchase_order_allocation();

-- ---------------------------------------------------------------------------
-- Reporting / operational views
-- ---------------------------------------------------------------------------

create or replace view public.purchase_order_item_summary
with (security_invoker = true)
as
select
  poi.id,
  poi.purchase_order_id,
  po.po_number,
  po.supplier_name,
  po.status,
  poi.product_id,
  poi.supplier_product_name,
  poi.portal_product_name,
  poi.sku,
  poi.bag_size,
  poi.grind,
  poi.unit_cost,
  poi.quantity_ordered,
  poi.quantity_received,
  poi.quantity_ordered - poi.quantity_received as quantity_outstanding,
  (poi.quantity_ordered * poi.unit_cost)::numeric(12,2) as extended_cost
from public.purchase_order_items poi
join public.purchase_orders po
  on po.id = poi.purchase_order_id;

create or replace view public.purchase_order_summary
with (security_invoker = true)
as
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
  coalesce(sum(poi.quantity_ordered), 0)::bigint as total_bags_ordered,
  coalesce(sum(poi.quantity_received), 0)::bigint as total_bags_received,
  coalesce(sum(poi.quantity_ordered * poi.unit_cost), 0)::numeric(12,2)
    as total_cost,
  count(poi.id)::bigint as product_lines,
  po.created_by,
  po.updated_by,
  po.created_at,
  po.updated_at
from public.purchase_orders po
left join public.purchase_order_items poi
  on poi.purchase_order_id = po.id
group by po.id;

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
  and o.wholesaler_status in ('not_ready', 'ready_to_submit')
  and oi.quantity - coalesce(a.allocated_quantity, 0) > 0;

-- ---------------------------------------------------------------------------
-- Auditing
-- ---------------------------------------------------------------------------

drop trigger if exists audit_purchase_orders on public.purchase_orders;
create trigger audit_purchase_orders
after insert or update or delete on public.purchase_orders
for each row execute function public.write_audit_log();

drop trigger if exists audit_purchase_order_items
  on public.purchase_order_items;
create trigger audit_purchase_order_items
after insert or update or delete on public.purchase_order_items
for each row execute function public.write_audit_log();

drop trigger if exists audit_purchase_order_allocations
  on public.purchase_order_allocations;
create trigger audit_purchase_order_allocations
after insert or update or delete on public.purchase_order_allocations
for each row execute function public.write_audit_log();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.purchase_order_allocations enable row level security;

drop policy if exists purchase_orders_read on public.purchase_orders;
create policy purchase_orders_read
on public.purchase_orders
for select
to authenticated
using (public.is_active_user());

drop policy if exists purchase_order_items_read
  on public.purchase_order_items;
create policy purchase_order_items_read
on public.purchase_order_items
for select
to authenticated
using (public.is_active_user());

drop policy if exists purchase_order_allocations_read
  on public.purchase_order_allocations;
create policy purchase_order_allocations_read
on public.purchase_order_allocations
for select
to authenticated
using (public.is_active_user());

-- Purchase-order creation and maintenance remain Coffee Bean responsibilities.
drop policy if exists purchase_orders_insert_admin on public.purchase_orders;
create policy purchase_orders_insert_admin
on public.purchase_orders
for insert
to authenticated
with check (
  public.has_any_role(array['coffee_bean']::public.app_role[])
  and created_by = (select auth.uid())
);

drop policy if exists purchase_orders_update_admin on public.purchase_orders;
create policy purchase_orders_update_admin
on public.purchase_orders
for update
to authenticated
using (public.has_any_role(array['coffee_bean']::public.app_role[]))
with check (public.has_any_role(array['coffee_bean']::public.app_role[]));

drop policy if exists purchase_orders_delete_admin on public.purchase_orders;
create policy purchase_orders_delete_admin
on public.purchase_orders
for delete
to authenticated
using (
  public.has_any_role(array['coffee_bean']::public.app_role[])
  and status = 'draft'
);

drop policy if exists purchase_order_items_insert_admin
  on public.purchase_order_items;
create policy purchase_order_items_insert_admin
on public.purchase_order_items
for insert
to authenticated
with check (
  public.has_any_role(array['coffee_bean']::public.app_role[])
  and created_by = (select auth.uid())
);

drop policy if exists purchase_order_items_update_admin
  on public.purchase_order_items;
create policy purchase_order_items_update_admin
on public.purchase_order_items
for update
to authenticated
using (public.has_any_role(array['coffee_bean']::public.app_role[]))
with check (public.has_any_role(array['coffee_bean']::public.app_role[]));

drop policy if exists purchase_order_items_delete_admin
  on public.purchase_order_items;
create policy purchase_order_items_delete_admin
on public.purchase_order_items
for delete
to authenticated
using (public.has_any_role(array['coffee_bean']::public.app_role[]));

drop policy if exists purchase_order_allocations_insert_admin
  on public.purchase_order_allocations;
create policy purchase_order_allocations_insert_admin
on public.purchase_order_allocations
for insert
to authenticated
with check (
  public.has_any_role(array['coffee_bean']::public.app_role[])
  and created_by = (select auth.uid())
);

drop policy if exists purchase_order_allocations_update_admin
  on public.purchase_order_allocations;
create policy purchase_order_allocations_update_admin
on public.purchase_order_allocations
for update
to authenticated
using (public.has_any_role(array['coffee_bean']::public.app_role[]))
with check (public.has_any_role(array['coffee_bean']::public.app_role[]));

drop policy if exists purchase_order_allocations_delete_admin
  on public.purchase_order_allocations;
create policy purchase_order_allocations_delete_admin
on public.purchase_order_allocations
for delete
to authenticated
using (public.has_any_role(array['coffee_bean']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant select on
  public.purchase_orders,
  public.purchase_order_items,
  public.purchase_order_allocations
to authenticated;

grant insert, update, delete on
  public.purchase_orders,
  public.purchase_order_items,
  public.purchase_order_allocations
to authenticated;

grant select on
  public.purchase_order_summary,
  public.purchase_order_item_summary,
  public.ready_to_order_items
to authenticated;

grant usage, select on sequence
  public.purchase_order_number_seq
to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------

select
  table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'purchase_orders',
    'purchase_order_items',
    'purchase_order_allocations'
  )
order by table_name;

select
  table_name
from information_schema.views
where table_schema = 'public'
  and table_name in (
    'purchase_order_summary',
    'purchase_order_item_summary',
    'ready_to_order_items'
  )
order by table_name;

select
  status,
  count(*) as purchase_orders
from public.purchase_orders
group by status
order by status;

select
  supplier_name,
  supplier_product_name,
  bag_size,
  grind,
  sum(quantity_available) as bags_ready
from public.ready_to_order_items
group by supplier_name, supplier_product_name, bag_size, grind
order by supplier_name, supplier_product_name, bag_size, grind;
