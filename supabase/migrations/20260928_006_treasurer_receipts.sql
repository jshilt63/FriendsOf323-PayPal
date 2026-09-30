begin;
create or replace function public.record_treasurer_receipt(p_order_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid());
begin
  if not public.has_any_role(array['coffee_bean','treasurer']::public.app_role[]) then
    raise exception 'Coffee Bean access is required.';
  end if;
  if not exists (select 1 from public.orders where id = p_order_id and payment_status = 'paid'
    and lower(coalesce(nullif(trim(payment_method),''), payment_provider, '')) in ('cash','venmo') and record_status = 'active') then
    raise exception 'Only active paid cash or Venmo orders can be recorded.';
  end if;
  insert into public.order_funding_tracking(order_id, recorded_by)
  values (p_order_id, v_user) on conflict (order_id) do nothing;
end $$;

create or replace function public.record_pack_bank_deposit(p_order_ids uuid[], p_reference text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_id uuid; v_order uuid; v_count integer; v_total numeric(12,2);
begin
  if not public.has_any_role(array['coffee_bean','treasurer']::public.app_role[]) then
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

create or replace function public.treasurer_confirm_order_payment(p_order_id uuid,p_method text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_order public.orders%rowtype; v_total numeric(12,2);
begin
  if not public.has_any_role(array['coffee_bean','treasurer']::public.app_role[]) then
    raise exception 'Treasurer access is required.';
  end if;
  if lower(trim(p_method)) not in ('cash','venmo') then raise exception 'Choose cash or Venmo.'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.record_status<>'active' then raise exception 'Active order not found.'; end if;
  if v_order.payment_status not in ('unpaid','paid') then raise exception 'Order has a partial or refunded payment.'; end if;
  if v_order.payment_status='paid' and
    lower(coalesce(nullif(trim(v_order.payment_method),''),v_order.payment_provider,''))<>lower(trim(p_method)) then
    raise exception 'Order is already paid by a different method.';
  end if;
  select coalesce(sum(line_total),0)+coalesce(v_order.processing_cost,0)+coalesce(v_order.shipping_amount,0)
    into v_total from public.order_items where order_id=p_order_id;
  if v_total<=0 then raise exception 'Order has no payable amount.'; end if;
  if v_order.payment_status='unpaid' then
    update public.orders set payment_status='paid',amount_paid=v_total,
      payment_method=lower(trim(p_method)),payment_provider=lower(trim(p_method)),
      wholesaler_status=case when wholesaler_status='not_ready' then 'ready_to_submit' else wholesaler_status end,
      updated_by=v_user where id=p_order_id;
  end if;
  insert into public.order_funding_tracking(order_id,recorded_by)
    values(p_order_id,v_user) on conflict(order_id) do nothing;
end $$;
revoke all on function public.treasurer_confirm_order_payment(uuid,text) from public,anon;
grant execute on function public.treasurer_confirm_order_payment(uuid,text) to authenticated;
commit;
