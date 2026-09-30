-- Cash/Venmo deposited directly to Pack checking can fund Scout credits without
-- manufacturing a Stripe charge or moving the same proceeds twice.
begin;

create table public.pack_bank_deposits (
  id uuid primary key default gen_random_uuid(),
  amount numeric(12,2) not null check (amount > 0),
  reference text not null check (length(trim(reference)) > 0),
  deposited_at timestamptz not null default now(),
  recorded_by uuid not null references auth.users(id)
);
alter table public.order_funding_tracking
  add column bank_deposit_id uuid references public.pack_bank_deposits(id);
create index order_funding_tracking_bank_deposit_idx on public.order_funding_tracking(bank_deposit_id);

alter table public.credit_payouts
  add column bank_offset_amount numeric(12,2) not null default 0 check (bank_offset_amount >= 0),
  add column stripe_amount numeric(12,2) generated always as (total_amount - bank_offset_amount) stored,
  add constraint credit_payout_bank_offset_limit check (bank_offset_amount <= total_amount);

create table public.pack_bank_deposit_allocations (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references public.pack_bank_deposits(id),
  payout_id uuid not null references public.credit_payouts(id),
  amount numeric(12,2) not null check (amount > 0),
  unique (deposit_id, payout_id)
);

alter table public.pack_bank_deposits enable row level security;
alter table public.pack_bank_deposit_allocations enable row level security;
create policy pack_bank_deposits_read on public.pack_bank_deposits for select to authenticated
  using (public.is_active_user());
create policy pack_bank_deposit_allocations_read on public.pack_bank_deposit_allocations for select to authenticated
  using (public.is_active_user());
grant select on public.pack_bank_deposits, public.pack_bank_deposit_allocations to authenticated;

create or replace function public.record_pack_bank_deposit(p_order_ids uuid[], p_reference text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_id uuid; v_order uuid; v_count integer; v_total numeric(12,2);
begin
  if not public.has_any_role(array['coffee_bean']::public.app_role[]) then
    raise exception 'Coffee Bean access is required.';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) = 0 or nullif(trim(p_reference),'') is null then
    raise exception 'Select received orders and enter the Pack bank deposit reference.';
  end if;
  if cardinality(p_order_ids) <> (select count(distinct x) from unnest(p_order_ids) x) then
    raise exception 'Choose each order once.';
  end if;
  for v_order in select order_id from public.order_funding_tracking
    where order_id = any(p_order_ids) order by order_id for update loop null; end loop;
  select count(*), sum(coalesce((select sum(i.line_total) from public.order_items i where i.order_id=o.id),0)
    + coalesce(o.processing_cost,0) + coalesce(o.shipping_amount,0))
    into v_count,v_total
  from public.order_funding_tracking t join public.orders o on o.id=t.order_id
  where o.id=any(p_order_ids) and t.bank_deposit_id is null
    and o.payment_status='paid' and o.record_status='active'
    and lower(coalesce(nullif(trim(o.payment_method),''),o.payment_provider,'')) in ('cash','venmo');
  if v_count<>cardinality(p_order_ids) or v_total<=0 then
    raise exception 'Each selected order must be paid, held by the Treasurer, and not already deposited.';
  end if;
  insert into public.pack_bank_deposits(amount,reference,recorded_by)
    values(v_total,trim(p_reference),v_user) returning id into v_id;
  update public.order_funding_tracking set bank_deposit_id=v_id
    where order_id=any(p_order_ids) and bank_deposit_id is null;
  if (select count(*) from public.order_funding_tracking where bank_deposit_id=v_id)<>v_count then
    raise exception 'Deposit selection changed. Please try again.';
  end if;
  return v_id;
end $$;

create or replace function public.reserve_pack_bank_offset(p_payout_id uuid,p_amount numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_payout public.credit_payouts%rowtype; v_deposit record; v_remaining numeric(12,2);
  v_free numeric(12,2); v_take numeric(12,2);
begin
  select * into v_payout from public.credit_payouts where id=p_payout_id for update;
  if not found or v_payout.status<>'draft' then raise exception 'Payout draft is unavailable.'; end if;
  if v_payout.bank_offset_amount<>0 then raise exception 'Bank funds are already reserved for this payout.'; end if;
  v_remaining:=round(coalesce(p_amount,-1),2);
  if v_remaining<0 or v_remaining>v_payout.total_amount then raise exception 'Invalid bank offset.'; end if;
  for v_deposit in select id,amount from public.pack_bank_deposits order by deposited_at,id for update loop
    exit when v_remaining<=0;
    select v_deposit.amount-coalesce(sum(a.amount),0) into v_free
      from public.pack_bank_deposit_allocations a join public.credit_payouts p on p.id=a.payout_id
      where a.deposit_id=v_deposit.id and p.status in ('draft','submitted','paid');
    v_take:=least(v_remaining,v_free);
    if v_take>0 then
      insert into public.pack_bank_deposit_allocations(deposit_id,payout_id,amount)
        values(v_deposit.id,p_payout_id,v_take);
      v_remaining:=v_remaining-v_take;
    end if;
  end loop;
  if v_remaining>0 then raise exception 'Only $% of deposited Pack bank funds remain unallocated.', round(p_amount-v_remaining,2); end if;
  update public.credit_payouts set bank_offset_amount=round(p_amount,2),updated_at=now() where id=p_payout_id;
  update public.scout_credit_transactions set notes=case when p_amount=v_payout.total_amount
    then 'Scout credit funded by cash/Venmo already deposited in Pack checking'
    when p_amount>0 then 'Scout credit funded by Pack bank deposit and Stripe payout'
    else 'Stripe payout to Pack bank account' end
    where id in (select transaction_id from public.credit_payout_lines where payout_id=p_payout_id);
  return jsonb_build_object('bank_offset_amount',round(p_amount,2),
    'stripe_amount',v_payout.total_amount-round(p_amount,2));
end $$;

create or replace function public.complete_bank_only_credit_payout(p_payout_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.credit_payouts set status='paid',submitted_at=now(),paid_at=now(),updated_at=now()
    where id=p_payout_id and status='draft' and stripe_amount=0 and bank_offset_amount>0;
  if not found then raise exception 'Bank-funded payout draft not found.'; end if;
end $$;

revoke all on function public.record_pack_bank_deposit(uuid[],text),
  public.reserve_pack_bank_offset(uuid,numeric), public.complete_bank_only_credit_payout(uuid)
  from public,anon,authenticated;
grant execute on function public.record_pack_bank_deposit(uuid[],text) to authenticated;
grant execute on function public.reserve_pack_bank_offset(uuid,numeric),
  public.complete_bank_only_credit_payout(uuid) to service_role;

create or replace view public.credit_payout_report with (security_invoker=true) as
select p.id as payout_id,p.payout_number,p.purpose,p.total_amount,p.status,p.stripe_payout_id,
  p.stripe_arrival_date,p.submitted_at,p.paid_at,p.created_at,l.id as line_id,l.amount,
  l.notification_status,l.notification_sent_at,s.id as scout_id,s.first_name as scout_first_name,
  s.last_name as scout_last_name,g.first_name as guardian_first_name,g.last_name as guardian_last_name,
  g.email as guardian_email,p.bank_offset_amount,p.stripe_amount
from public.credit_payouts p
join public.credit_payout_lines l on l.payout_id=p.id
join public.scouts s on s.id=l.scout_id
left join public.scout_guardians sg on sg.scout_id=s.id and sg.is_primary
left join public.guardians g on g.id=sg.guardian_id;
grant select on public.credit_payout_report to authenticated;
commit;
