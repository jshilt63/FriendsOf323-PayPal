-- Release reserved Scout credits and deposited-fund offsets if a Pack payout fails.
begin;
create or replace function public.fail_credit_payout_draft(p_payout_id uuid,p_message text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if not exists(select 1 from public.credit_payouts where id=p_payout_id and status='draft' for update) then return; end if;
  select array_agg(transaction_id) into v_ids from public.credit_payout_lines
    where payout_id=p_payout_id and transaction_id is not null;
  update public.credit_payout_lines set transaction_id=null where payout_id=p_payout_id;
  delete from public.scout_credit_transactions where id=any(coalesce(v_ids,array[]::uuid[]));
  update public.credit_payouts set status='failed',failure_message=left(coalesce(p_message,'Payout failed.'),1000),
    updated_at=now() where id=p_payout_id;
end $$;

create or replace function public.update_credit_payout_from_stripe(
  p_stripe_payout_id text,p_status text,p_failure_message text default null,p_arrival_date date default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_ids uuid[];
begin
  if p_status not in ('paid','failed','canceled','submitted') then return; end if;
  select id into v_id from public.credit_payouts where stripe_payout_id=p_stripe_payout_id for update;
  if v_id is null then return; end if;
  if p_status in ('failed','canceled') then
    select array_agg(transaction_id) into v_ids from public.credit_payout_lines
      where payout_id=v_id and transaction_id is not null;
    update public.credit_payout_lines set transaction_id=null where payout_id=v_id;
    delete from public.scout_credit_transactions where id=any(coalesce(v_ids,array[]::uuid[]));
  end if;
  update public.credit_payouts set status=p_status,
    paid_at=case when p_status='paid' then now() else paid_at end,
    failure_message=case when p_status in ('failed','canceled') then p_failure_message else failure_message end,
    stripe_arrival_date=coalesce(p_arrival_date,stripe_arrival_date),updated_at=now()
    where id=v_id;
end $$;
revoke all on function public.fail_credit_payout_draft(uuid,text),
  public.update_credit_payout_from_stripe(text,text,text,date) from public,anon,authenticated;
grant execute on function public.fail_credit_payout_draft(uuid,text),
  public.update_credit_payout_from_stripe(text,text,text,date) to service_role;
commit;
