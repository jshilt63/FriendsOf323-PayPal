-- Correct the funding amount for schemas where orders have no order_total column.
begin;
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

revoke all on function public.initiate_funding_transfer(uuid[],text) from public, anon;
grant execute on function public.initiate_funding_transfer(uuid[],text) to authenticated;
commit;
