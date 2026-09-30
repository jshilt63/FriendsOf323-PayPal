-- Optional Stripe payout to Pack checking for paying an already submitted roaster PO.
begin;

create table public.roaster_funding_settings (
  id integer primary key check (id=1),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
insert into public.roaster_funding_settings(id,enabled) values(1,false);
alter table public.roaster_funding_settings enable row level security;
create policy roaster_funding_settings_read on public.roaster_funding_settings for select to authenticated
  using (public.is_active_user());
create policy roaster_funding_settings_write on public.roaster_funding_settings for update to authenticated
  using (public.has_any_role(array['coffee_bean']::public.app_role[]))
  with check (public.has_any_role(array['coffee_bean']::public.app_role[]));
grant select,update on public.roaster_funding_settings to authenticated;

create table public.roaster_funding_payouts (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id),
  amount numeric(12,2) not null check (amount>0),
  status text not null default 'draft' check (status in ('draft','submitted','paid','failed','canceled')),
  stripe_payout_id text unique,
  stripe_arrival_date date,
  failure_message text,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  paid_at timestamptz,
  created_by uuid not null references auth.users(id)
);
create unique index roaster_funding_one_active_per_po
  on public.roaster_funding_payouts(purchase_order_id) where status in ('draft','submitted','paid');
alter table public.roaster_funding_payouts enable row level security;
create policy roaster_funding_payouts_read on public.roaster_funding_payouts for select to authenticated
  using (public.is_active_user());
grant select on public.roaster_funding_payouts to authenticated;

create or replace function public.create_roaster_funding_draft(p_po_id uuid,p_created_by uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_po public.purchase_orders%rowtype; v_amount numeric(12,2); v_id uuid;
begin
  if not (select enabled from public.roaster_funding_settings where id=1) then
    raise exception 'Roaster Funding Payout is disabled.';
  end if;
  select * into v_po from public.purchase_orders where id=p_po_id for update;
  if not found or v_po.status not in ('submitted','partially_received','received') then
    raise exception 'Submit the purchase order before requesting roaster funding.';
  end if;
  if exists(select 1 from public.roaster_funding_payouts where purchase_order_id=p_po_id
    and status in ('draft','submitted','paid')) then
    raise exception 'This purchase order already has a roaster funding payout.';
  end if;
  select coalesce((select sum(quantity_ordered*unit_cost) from public.purchase_order_items where purchase_order_id=p_po_id),0)
       + coalesce((select sum(quantity_ordered*unit_cost) from public.purchase_order_manual_items where purchase_order_id=p_po_id),0)
    into v_amount;
  if v_amount<=0 then raise exception 'Purchase order has no roaster cost to fund.'; end if;
  insert into public.roaster_funding_payouts(purchase_order_id,amount,created_by)
    values(p_po_id,v_amount,p_created_by) returning id into v_id;
  return jsonb_build_object('id',v_id,'po_number',v_po.po_number,'amount',v_amount);
end $$;

create or replace function public.mark_roaster_funding_submitted(p_id uuid,p_stripe_id text,p_arrival date)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.roaster_funding_payouts set status='submitted',stripe_payout_id=p_stripe_id,
    stripe_arrival_date=p_arrival,submitted_at=now() where id=p_id and status='draft';
  if not found then raise exception 'Roaster funding draft not found.'; end if;
end $$;

create or replace function public.update_roaster_funding_from_stripe(p_stripe_id text,p_status text,p_failure text,p_arrival date)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.roaster_funding_payouts set status=p_status,
    paid_at=case when p_status='paid' then now() else paid_at end,
    failure_message=case when p_status='failed' then p_failure else failure_message end,
    stripe_arrival_date=coalesce(p_arrival,stripe_arrival_date)
    where stripe_payout_id=p_stripe_id and p_status in ('paid','failed','canceled');
end $$;

create or replace function public.fail_roaster_funding_draft(p_id uuid,p_message text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.roaster_funding_payouts set status='failed',failure_message=left(p_message,1000)
    where id=p_id and status='draft';
end $$;

revoke all on function public.create_roaster_funding_draft(uuid,uuid),
 public.mark_roaster_funding_submitted(uuid,text,date),
 public.update_roaster_funding_from_stripe(text,text,text,date),
 public.fail_roaster_funding_draft(uuid,text) from public,anon,authenticated;
grant execute on function public.create_roaster_funding_draft(uuid,uuid),
 public.mark_roaster_funding_submitted(uuid,text,date),
 public.update_roaster_funding_from_stripe(text,text,text,date),
 public.fail_roaster_funding_draft(uuid,text) to service_role;
commit;
