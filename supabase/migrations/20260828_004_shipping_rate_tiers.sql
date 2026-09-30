-- Friends of 323
-- Configurable bag-count shipping rates and per-order applied shipping charge.

begin;

create table if not exists public.shipping_rate_tiers (
  id uuid primary key default gen_random_uuid(),
  label text not null check (btrim(label) <> ''),
  min_bags integer not null check (min_bags >= 1),
  max_bags integer check (max_bags is null or max_bags >= min_bags),
  rate_amount numeric(10,2) not null check (rate_amount >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id)
);

create index if not exists shipping_rate_tiers_active_range_idx
  on public.shipping_rate_tiers (is_active desc, min_bags, max_bags);

drop trigger if exists shipping_rate_tiers_set_updated_at on public.shipping_rate_tiers;
create trigger shipping_rate_tiers_set_updated_at
before update on public.shipping_rate_tiers
for each row execute function public.set_updated_at();

drop trigger if exists audit_shipping_rate_tiers on public.shipping_rate_tiers;
create trigger audit_shipping_rate_tiers
after insert or update or delete on public.shipping_rate_tiers
for each row execute function public.write_audit_log();

create or replace function public.prevent_overlapping_shipping_rates()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_active and exists (
    select 1
    from public.shipping_rate_tiers r
    where r.id <> new.id
      and r.is_active
      and int4range(r.min_bags, coalesce(r.max_bags, 2147483646) + 1, '[)')
          && int4range(new.min_bags, coalesce(new.max_bags, 2147483646) + 1, '[)')
  ) then
    raise exception 'Active shipping bag-count ranges cannot overlap.';
  end if;
  return new;
end;
$$;

drop trigger if exists shipping_rate_tiers_no_overlap on public.shipping_rate_tiers;
create trigger shipping_rate_tiers_no_overlap
before insert or update on public.shipping_rate_tiers
for each row execute function public.prevent_overlapping_shipping_rates();

alter table public.shipping_rate_tiers enable row level security;

drop policy if exists shipping_rate_tiers_read on public.shipping_rate_tiers;
create policy shipping_rate_tiers_read
on public.shipping_rate_tiers
for select
to authenticated
using (public.is_active_user());

drop policy if exists shipping_rate_tiers_admin_manage on public.shipping_rate_tiers;
create policy shipping_rate_tiers_admin_manage
on public.shipping_rate_tiers
for all
to authenticated
using (public.has_any_role(array['coffee_bean']::public.app_role[]))
with check (public.has_any_role(array['coffee_bean']::public.app_role[]));

grant select, insert, update, delete on public.shipping_rate_tiers to authenticated;

alter table public.orders
  add column if not exists shipping_amount numeric(10,2) not null default 0
    check (shipping_amount >= 0),
  add column if not exists shipping_rate_id uuid references public.shipping_rate_tiers(id) on delete set null,
  add column if not exists shipping_rate_label text,
  add column if not exists shipping_bag_count integer check (shipping_bag_count is null or shipping_bag_count >= 0);

comment on column public.orders.shipping_amount is
  'Shipping charge captured when the order was placed. Historical orders retain this value if rate tiers later change.';

-- Include shipping in the notification/payment total used by checkout emails.
create or replace function public.get_order_notification_payload(
    p_order_id uuid
)
returns jsonb
language sql
security definer
stable
set search_path = ''
as $function$
with selected_order as (
    select
        o.id,
        o.order_number,
        o.store_order_number,
        o.ecwid_order_number,
        o.order_source,
        o.order_date,
        o.customer_id,
        o.payment_status,
        o.wholesaler_status,
        o.amount_paid,
        o.processing_cost,
        o.shipping_amount,
        o.shipping_rate_label,
        o.shipping_bag_count,
        o.payment_method,
        o.payment_provider,
        o.payment_transaction_id
    from public.orders o
    where o.id = p_order_id
),
customer_data as (
    select
        c.id,
        c.first_name,
        c.last_name,
        c.email,
        c.phone
    from public.customers c
    join selected_order o on o.customer_id = c.id
),
item_data as (
    select
        oi.id,
        oi.product_id,
        p.product_name,
        p.bag_size::text as bag_size,
        oi.quantity,
        oi.line_total,
        oi.fundraising_credit_total,
        case
            when lower(coalesce(oi.notes, '')) like '%whole bean%' then 'Whole Bean'
            else 'Ground'
        end as grind_label,
        s.first_name as scout_first_name,
        s.last_name as scout_last_name,
        s.is_general_fund
    from public.order_items oi
    join selected_order o on o.id = oi.order_id
    join public.products p on p.id = oi.product_id
    join public.scouts s on s.id = oi.scout_id
    order by p.product_name, oi.id
),
totals as (
    select
        coalesce(sum(oi.line_total), 0)::numeric(12,2)
          + coalesce((select processing_cost from selected_order), 0)::numeric(12,2)
          + coalesce((select shipping_amount from selected_order), 0)::numeric(12,2)
          as order_total
    from public.order_items oi
    join selected_order o on o.id = oi.order_id
)
select jsonb_build_object(
    'order',
    (
      select to_jsonb(o) || jsonb_build_object(
        'order_total', t.order_total,
        'amount_due', greatest(t.order_total - coalesce(o.amount_paid, 0), 0)
      )
      from selected_order o
      cross join totals t
    ),
    'customer',
    (select to_jsonb(c) from customer_data c),
    'items',
    coalesce((select jsonb_agg(to_jsonb(i)) from item_data i), '[]'::jsonb)
);
$function$;

revoke all on function public.get_order_notification_payload(uuid) from public;
revoke all on function public.get_order_notification_payload(uuid) from anon;
revoke all on function public.get_order_notification_payload(uuid) from authenticated;
grant execute on function public.get_order_notification_payload(uuid) to service_role;

commit;
