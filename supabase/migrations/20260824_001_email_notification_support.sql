begin;

-- Friends of 323
-- Complete database support for Gmail order notifications.
-- Safe to run if some of the earlier storefront notification migrations
-- have already been applied.

create table if not exists public.order_notification_deliveries (
    id uuid primary key default gen_random_uuid(),
    order_id uuid not null references public.orders(id) on delete cascade,
    recipient_user_id uuid null references auth.users(id) on delete set null,
    recipient_email text not null,
    notification_type text not null default 'internal',
    sent_at timestamptz null,
    last_attempt_at timestamptz not null default now(),
    last_error text null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint order_notification_deliveries_email_not_blank
      check (nullif(trim(recipient_email), '') is not null)
);

-- Upgrade an older version of the delivery ledger if it already exists.
alter table public.order_notification_deliveries
    add column if not exists notification_type text;

update public.order_notification_deliveries
set notification_type = 'internal'
where notification_type is null;

alter table public.order_notification_deliveries
    alter column notification_type set default 'internal';

alter table public.order_notification_deliveries
    alter column notification_type set not null;

alter table public.order_notification_deliveries
    drop constraint if exists order_notification_deliveries_notification_type_valid;

alter table public.order_notification_deliveries
    add constraint order_notification_deliveries_notification_type_valid
    check (notification_type in ('internal', 'customer_confirmation'));

alter table public.order_notification_deliveries
    drop constraint if exists order_notification_deliveries_order_email_unique;

alter table public.order_notification_deliveries
    drop constraint if exists order_notification_deliveries_order_email_type_unique;

alter table public.order_notification_deliveries
    add constraint order_notification_deliveries_order_email_type_unique
    unique (order_id, recipient_email, notification_type);

alter table public.order_notification_deliveries enable row level security;

revoke all on table public.order_notification_deliveries from public;
revoke all on table public.order_notification_deliveries from anon;
revoke all on table public.order_notification_deliveries from authenticated;
grant select, insert, update on table public.order_notification_deliveries to service_role;

-- Payload used by the Netlify checkout/webhook functions for both
-- internal order alerts and customer confirmations.
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

-- Verification: both queries should return rows / valid results.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'order_notification_deliveries'
order by ordinal_position;

select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('get_order_notification_recipients', 'get_order_notification_payload')
order by routine_name;
