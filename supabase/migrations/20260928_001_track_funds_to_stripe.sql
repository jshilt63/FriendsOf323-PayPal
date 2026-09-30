-- Record the Treasurer's custody and bank-to-Stripe funding separately from customer payment.
begin;

create table if not exists public.funding_transfers (
  id uuid primary key default gen_random_uuid(),
  amount numeric(12,2) not null check (amount > 0),
  bank_reference text not null check (length(trim(bank_reference)) > 0),
  status text not null default 'initiated' check (status in ('initiated','complete')),
  initiated_at timestamptz not null default now(),
  completed_at timestamptz,
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id)
);

create table if not exists public.order_funding_tracking (
  order_id uuid primary key references public.orders(id),
  treasurer_received_at timestamptz not null default now(),
  recorded_by uuid not null references auth.users(id),
  funding_transfer_id uuid references public.funding_transfers(id)
);

create index if not exists order_funding_tracking_transfer_idx
  on public.order_funding_tracking(funding_transfer_id);

alter table public.funding_transfers enable row level security;
alter table public.order_funding_tracking enable row level security;

create policy funding_transfers_read on public.funding_transfers for select to authenticated
  using (public.is_active_user());
create policy order_funding_tracking_read on public.order_funding_tracking for select to authenticated
  using (public.is_active_user());

grant select on public.funding_transfers, public.order_funding_tracking to authenticated;

create or replace function public.record_treasurer_receipt(p_order_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid());
begin
  if not public.has_any_role(array['coffee_bean']::public.app_role[]) then
    raise exception 'Coffee Bean access is required.';
  end if;
  if not exists (select 1 from public.orders where id = p_order_id and payment_status = 'paid'
    and lower(coalesce(nullif(trim(payment_method),''), payment_provider, '')) in ('cash','venmo') and record_status = 'active') then
    raise exception 'Only active paid cash or Venmo orders can be recorded.';
  end if;
  insert into public.order_funding_tracking(order_id, recorded_by)
  values (p_order_id, v_user) on conflict (order_id) do nothing;
end $$;

create or replace function public.initiate_funding_transfer(p_order_ids uuid[], p_bank_reference text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_count integer; v_total numeric(12,2); v_id uuid; v_locked uuid;
begin
  if not public.has_any_role(array['coffee_bean']::public.app_role[]) then
    raise exception 'Coffee Bean access is required.';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) = 0 or nullif(trim(p_bank_reference), '') is null then
    raise exception 'Choose orders and enter the bank transfer reference.';
  end if;
  if cardinality(p_order_ids) <> (select count(distinct x) from unnest(p_order_ids) x) then
    raise exception 'Choose each order once.';
  end if;
  for v_locked in select order_id from public.order_funding_tracking
    where order_id = any(p_order_ids) order by order_id for update loop
    null;
  end loop;
  select count(*), sum(coalesce((select sum(oi.line_total) from public.order_items oi where oi.order_id = o.id), 0)
    + coalesce(o.processing_cost, 0) + coalesce(o.shipping_amount, 0)) into v_count, v_total
  from public.order_funding_tracking t join public.orders o on o.id = t.order_id
  where o.id = any(p_order_ids) and t.funding_transfer_id is null
    and o.payment_status = 'paid' and o.record_status = 'active'
    and lower(coalesce(nullif(trim(o.payment_method),''), o.payment_provider, '')) in ('cash','venmo');
  if v_count <> cardinality(p_order_ids) or v_total <= 0 then
    raise exception 'Every selected order must be paid, received by the Treasurer, and not already transferred.';
  end if;
  insert into public.funding_transfers(amount, bank_reference, created_by)
    values (v_total, trim(p_bank_reference), v_user) returning id into v_id;
  update public.order_funding_tracking set funding_transfer_id = v_id
    where order_id = any(p_order_ids) and funding_transfer_id is null;
  if not found then raise exception 'Orders changed during transfer creation.'; end if;
  return v_id;
end $$;

create or replace function public.complete_funding_transfer(p_transfer_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_any_role(array['coffee_bean']::public.app_role[]) then
    raise exception 'Coffee Bean access is required.';
  end if;
  update public.funding_transfers set status = 'complete', completed_at = now(), updated_by = (select auth.uid())
    where id = p_transfer_id and status = 'initiated';
  if not found then raise exception 'Transfer is not pending.'; end if;
end $$;

revoke all on function public.record_treasurer_receipt(uuid),
  public.initiate_funding_transfer(uuid[],text), public.complete_funding_transfer(uuid) from public, anon;
grant execute on function public.record_treasurer_receipt(uuid),
  public.initiate_funding_transfer(uuid[],text), public.complete_funding_transfer(uuid) to authenticated;
commit;
