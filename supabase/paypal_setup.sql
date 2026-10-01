-- Additive PayPal setup for the existing Friends of 323 project.
-- Run in Supabase SQL Editor. Existing Stripe tables/functions are left intact
-- because the separate live Stripe site still needs them.
begin;
create table if not exists public.paypal_checkouts (
 id uuid primary key default gen_random_uuid(),
 environment text not null check(environment in ('sandbox','live')),
 request_key uuid not null, fingerprint text not null,
 order_id uuid references public.orders(id), store_order_number text,
 paypal_order_id text, capture_id text,
 amount numeric(12,2) not null check(amount>0), currency text not null default 'USD' check(currency='USD'),
 fee_amount numeric(12,2) check(fee_amount>=0), refunded_amount numeric(12,2) not null default 0 check(refunded_amount>=0 and refunded_amount<=amount),
 status text not null default 'created' check(status in ('created','completed','partially_refunded','refunded')),
 payload jsonb not null, created_at timestamptz not null default now(), completed_at timestamptz,
 unique(environment,request_key), unique(environment,paypal_order_id), unique(environment,capture_id),
 check(environment<>'sandbox' or order_id is null)
);
create table if not exists public.paypal_refunds (
 id uuid primary key default gen_random_uuid(), checkout_id uuid not null references public.paypal_checkouts(id),
 refund_id text not null unique, amount numeric(12,2) not null check(amount>0), currency text not null check(currency='USD'),
 reason text, created_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create table if not exists public.paypal_webhook_events (
 environment text not null check(environment in ('sandbox','live')), event_id text not null,
 event_type text not null, received_at timestamptz not null default now(), processed_at timestamptz,
 primary key(environment,event_id)
);
create table if not exists public.paypal_pack_transfers (
 id uuid primary key default gen_random_uuid(),request_key uuid not null unique,
 source text not null check(source in ('paypal','bank')),reference text not null,
 purpose text not null,amount numeric(12,2) not null check(amount>0),transfer_date date not null,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),unique(source,reference)
);
create table if not exists public.paypal_pack_transfer_lines (
 id uuid primary key default gen_random_uuid(),transfer_id uuid not null references public.paypal_pack_transfers(id),
 scout_id uuid not null references public.scouts(id),amount numeric(12,2) not null check(amount>0),
 transaction_id uuid not null references public.scout_credit_transactions(id),
 notification_status text not null default 'pending' check(notification_status in ('pending','sending','sent','failed','no_email')),notification_sent_at timestamptz,unique(transfer_id,scout_id)
);
-- Explicit RLS and grants: anonymous customers access payment records only via
-- server functions, never via direct table reads/writes.
alter table public.paypal_checkouts enable row level security;
alter table public.paypal_refunds enable row level security;
alter table public.paypal_webhook_events enable row level security;
alter table public.paypal_pack_transfers enable row level security;
alter table public.paypal_pack_transfer_lines enable row level security;
revoke all on public.paypal_checkouts,public.paypal_refunds,public.paypal_webhook_events,public.paypal_pack_transfers,public.paypal_pack_transfer_lines from anon,authenticated;
grant select on public.paypal_checkouts,public.paypal_refunds,public.paypal_webhook_events,public.paypal_pack_transfers,public.paypal_pack_transfer_lines to authenticated;
grant all on public.paypal_checkouts,public.paypal_refunds,public.paypal_webhook_events,public.paypal_pack_transfers,public.paypal_pack_transfer_lines to service_role;
do $$ declare t text; begin
 foreach t in array array['paypal_checkouts','paypal_refunds','paypal_webhook_events','paypal_pack_transfers','paypal_pack_transfer_lines'] loop
  execute format('drop policy if exists paypal_staff_read on public.%I',t);
  execute format('create policy paypal_staff_read on public.%I for select to authenticated using (exists (select 1 from public.user_profiles p where p.id=(select auth.uid()) and p.is_active and p.role::text in (''coffee_bean'',''barista'',''committee_member'',''treasurer'')))',t);
 end loop;
end $$;
create index if not exists paypal_checkouts_created_idx on public.paypal_checkouts(created_at desc);
create index if not exists paypal_refunds_checkout_idx on public.paypal_refunds(checkout_id);

create or replace function public.prepare_paypal_live_order(p_checkout_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.paypal_checkouts%rowtype;o jsonb;total numeric; begin
 select * into c from public.paypal_checkouts where id=p_checkout_id for update;
 if not found or c.environment<>'live' then raise exception 'Live checkout is required.';end if;
 if c.order_id is not null then return to_jsonb(c);end if;
 o:=public.create_storefront_order(c.payload->'customer',c.payload->'items',(c.payload->>'processing_cost')::numeric);
 select coalesce(sum(line_total),0)+(c.payload->>'processing_cost')::numeric+coalesce((c.payload->'fulfillment'->>'shipping_amount')::numeric,0)
 into total from public.order_items where order_id=(o->>'order_id')::uuid;
 if round(total,2)<>c.amount then raise exception 'Prices changed. Start a new checkout.';end if;
 update public.orders set
  payment_provider='paypal',payment_method='card',payment_status='unpaid',amount_paid=0,
  fulfillment_method=c.payload->'fulfillment'->>'fulfillment_method',
  shipping_amount=coalesce((c.payload->'fulfillment'->>'shipping_amount')::numeric,0),
  shipping_rate_id=(c.payload->'fulfillment'->>'shipping_rate_id')::uuid,
  shipping_bag_count=(c.payload->'fulfillment'->>'shipping_bag_count')::integer,
  shipping_rate_source=c.payload->'fulfillment'->>'shipping_rate_source',
  shipping_carrier=c.payload->'fulfillment'->>'shipping_carrier',
  shipping_rate_retail=(c.payload->'fulfillment'->>'shipping_rate_retail')::numeric,
  shipping_rate_list=(c.payload->'fulfillment'->>'shipping_rate_list')::numeric,
  shipping_rate_account=(c.payload->'fulfillment'->>'shipping_rate_account')::numeric,
  shipping_package_weight_ounces=(c.payload->'fulfillment'->>'shipping_package_weight_ounces')::numeric,
  shipping_rate_label=c.payload->'fulfillment'->>'shipping_rate_label',
  shipping_service=c.payload->'fulfillment'->>'shipping_service',
  shipping_postage_amount=(c.payload->'fulfillment'->>'shipping_postage_amount')::numeric,
  shipping_packaging_charge=(c.payload->'fulfillment'->>'shipping_packaging_charge')::numeric,
  shipping_easypost_rate_id=c.payload->'fulfillment'->>'shipping_easypost_rate_id',
  shipping_easypost_shipment_id=c.payload->'fulfillment'->>'shipping_easypost_shipment_id',
  shipping_rate_environment=c.payload->'fulfillment'->>'shipping_rate_environment'
 where id=(o->>'order_id')::uuid;
 update public.paypal_checkouts set order_id=(o->>'order_id')::uuid,store_order_number=o->>'store_order_number' where id=c.id returning * into c;
 return to_jsonb(c);
end $$;
create or replace function public.complete_paypal_checkout(p_checkout_id uuid,p_paypal_order_id text,p_capture_id text,p_amount numeric,p_currency text,p_fee numeric)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.paypal_checkouts%rowtype;total numeric;begin
 select * into c from public.paypal_checkouts where id=p_checkout_id for update;
 if not found then raise exception 'Checkout not found.';end if;
 if c.paypal_order_id is distinct from p_paypal_order_id or c.amount is distinct from p_amount or c.currency is distinct from p_currency
 or nullif(p_capture_id,'') is null then raise exception 'PayPal capture does not match checkout.';end if;
 if c.capture_id is not null and c.capture_id<>p_capture_id then raise exception 'Checkout already has a different capture.';end if;
 if c.status in ('partially_refunded','refunded') then return to_jsonb(c);end if;
 if c.environment='live' then
  if c.order_id is null then raise exception 'Production order link is missing.';end if;
  perform 1 from public.orders where id=c.order_id and record_status='active' and payment_provider='paypal' for update;
  if not found then raise exception 'Live order is not active or does not belong to PayPal.';end if;
  select coalesce(sum(i.line_total),0)+o.processing_cost+coalesce(o.shipping_amount,0) into total
  from public.orders o left join public.order_items i on i.order_id=o.id where o.id=c.order_id group by o.processing_cost,o.shipping_amount;
  if round(total,2)<>c.amount then raise exception 'Live order total differs from captured amount.';end if;
  update public.orders set payment_status='paid',amount_paid=c.amount,payment_provider='paypal',payment_method='card',payment_session_id=p_paypal_order_id,payment_transaction_id=p_capture_id where id=c.order_id;
 end if;
 update public.paypal_checkouts set status='completed',capture_id=p_capture_id,fee_amount=coalesce(p_fee,fee_amount),completed_at=coalesce(completed_at,now()) where id=c.id returning * into c;
 return to_jsonb(c);
end $$;
create or replace function public.record_paypal_refund(p_checkout_id uuid,p_refund_id text,p_amount numeric,p_currency text,p_reason text,p_user_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.paypal_checkouts%rowtype;v_total numeric;existing public.paypal_refunds%rowtype;begin
 select * into c from public.paypal_checkouts where id=p_checkout_id for update;
 if not found or c.capture_id is null or c.status not in ('completed','partially_refunded','refunded') then raise exception 'Completed capture is required.';end if;
 if nullif(p_refund_id,'') is null or p_amount is null or p_amount<=0 or p_currency is distinct from c.currency then raise exception 'Invalid refund.';end if;
 select * into existing from public.paypal_refunds where refund_id=p_refund_id;
 if found then
  if existing.checkout_id<>c.id or existing.amount<>p_amount then raise exception 'Refund ID was already used.';end if;
  return to_jsonb(c);
 end if;
 v_total:=c.refunded_amount+p_amount;
 if v_total>c.amount then raise exception 'Refund exceeds captured amount.';end if;
 insert into public.paypal_refunds(checkout_id,refund_id,amount,currency,reason,created_by)values(c.id,p_refund_id,p_amount,p_currency,p_reason,p_user_id);
 update public.paypal_checkouts set refunded_amount=v_total,status=case when v_total=c.amount then 'refunded' else 'partially_refunded' end where id=c.id returning * into c;
 if c.environment='live' then
  update public.orders set amount_paid=c.amount-v_total,refunded_amount=v_total,refund_transaction_id=p_refund_id,refunded_at=now(),
   payment_status=case when v_total=c.amount then 'refunded'::public.payment_status else 'partially_paid'::public.payment_status end,
   record_status=case when v_total=c.amount then 'voided'::public.order_record_status else record_status end,
   void_reason=case when v_total=c.amount then coalesce(nullif(p_reason,''),'PayPal full refund') else void_reason end,
   voided_at=case when v_total=c.amount then now() else voided_at end,voided_by=coalesce(p_user_id,voided_by)
  where id=c.order_id and payment_provider='paypal';
 end if;
 return to_jsonb(c);
end $$;
create or replace function public.record_paypal_pack_transfer(p_request_key uuid,p_created_by uuid,p_source text,p_reference text,p_purpose text,p_date date,p_lines jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare t public.paypal_pack_transfers%rowtype;l jsonb;sid uuid;a numeric;avail numeric;total numeric:=0;tid uuid;begin
 if not exists(select 1 from public.user_profiles where id=p_created_by and is_active and role::text='coffee_bean')then raise exception 'Coffee Bean access required.';end if;
 if p_request_key is null or p_source not in ('paypal','bank') or nullif(btrim(p_reference),'')is null or nullif(btrim(p_purpose),'')is null or p_date is null then raise exception 'Transfer details are required.';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_key::text,0));
 select * into t from public.paypal_pack_transfers where request_key=p_request_key;
 if found then return to_jsonb(t);end if;
 if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines)<1 then raise exception 'Select Scout credits.';end if;
 if (select count(*) from jsonb_array_elements(p_lines))<>(select count(distinct x->>'scout_id')from jsonb_array_elements(p_lines)x) then raise exception 'Duplicate Scout lines.';end if;
 -- Lock in a stable order; uses the same scout locks as legacy payouts.
 for l in select value from jsonb_array_elements(p_lines) order by value->>'scout_id' loop
  sid:=(l->>'scout_id')::uuid;a:=(l->>'amount')::numeric;
  if a is null or a<=0 or a<>round(a,2) then raise exception 'Amounts must be positive dollars and cents.';end if;
  perform 1 from public.scouts where id=sid and is_active and not is_general_fund for update;
  if not found then raise exception 'Scout missing, inactive, or General Fund.';end if;
  select coalesce(available_credit,0)into avail from public.scout_summary where scout_id=sid;
  if a>coalesce(avail,0) then raise exception 'Amount exceeds available Scout credit.';end if;total:=total+a;
 end loop;
 insert into public.paypal_pack_transfers(request_key,source,reference,purpose,amount,transfer_date,created_by)
 values(p_request_key,p_source,btrim(p_reference),btrim(p_purpose),total,p_date,p_created_by)returning * into t;
 for l in select value from jsonb_array_elements(p_lines)loop
  sid:=(l->>'scout_id')::uuid;a:=(l->>'amount')::numeric;
  insert into public.scout_credit_transactions(scout_id,transaction_type,amount,transaction_date,purpose,reference_number,notes,created_by,updated_by)
  values(sid,'transfer_to_pack',a,p_date,p_purpose,p_reference,'Completed transfer recorded from '||p_source,p_created_by,p_created_by)returning id into tid;
  insert into public.paypal_pack_transfer_lines(transfer_id,scout_id,amount,transaction_id)values(t.id,sid,a,tid);
 end loop;
 return to_jsonb(t);
end $$;
revoke all on function public.prepare_paypal_live_order(uuid),public.complete_paypal_checkout(uuid,text,text,numeric,text,numeric),public.record_paypal_refund(uuid,text,numeric,text,text,uuid),public.record_paypal_pack_transfer(uuid,uuid,text,text,text,date,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_paypal_live_order(uuid),public.complete_paypal_checkout(uuid,text,text,numeric,text,numeric),public.record_paypal_refund(uuid,text,numeric,text,text,uuid),public.record_paypal_pack_transfer(uuid,uuid,text,text,text,date,jsonb) to service_role;
commit;
-- Verification (no mutations):
select relname,relrowsecurity from pg_class where relname in ('paypal_checkouts','paypal_refunds','paypal_webhook_events','paypal_pack_transfers','paypal_pack_transfer_lines');
