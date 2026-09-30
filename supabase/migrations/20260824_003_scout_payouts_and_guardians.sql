-- Friends of 323
-- Scout credit payouts, parent/guardian contacts, Stripe payout tracking,
-- parent notification audit, and treasurer reporting.
-- Safe to run once on the production database.

begin;

create table if not exists public.guardians (
  id uuid primary key default gen_random_uuid(),
  first_name text,
  last_name text,
  email text,
  phone text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id)
);

create unique index if not exists guardians_email_lower_unique
  on public.guardians (lower(email))
  where email is not null and btrim(email) <> '';

create table if not exists public.scout_guardians (
  scout_id uuid not null references public.scouts(id) on delete cascade,
  guardian_id uuid not null references public.guardians(id) on delete cascade,
  relationship text,
  is_primary boolean not null default false,
  receive_credit_notifications boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  primary key (scout_id, guardian_id)
);

create unique index if not exists scout_guardians_one_primary
  on public.scout_guardians (scout_id)
  where is_primary;

create sequence if not exists public.credit_payout_number_seq start 1;

create table if not exists public.credit_payouts (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  payout_number text not null unique,
  purpose text not null,
  total_amount numeric(12,2) not null default 0 check (total_amount >= 0),
  currency text not null default 'usd',
  status text not null default 'draft'
    check (status in ('draft','submitted','paid','failed','canceled')),
  stripe_payout_id text unique,
  stripe_arrival_date date,
  failure_message text,
  submitted_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id)
);

create table if not exists public.credit_payout_lines (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.credit_payouts(id) on delete cascade,
  scout_id uuid not null references public.scouts(id),
  amount numeric(12,2) not null check (amount > 0),
  transaction_id uuid references public.scout_credit_transactions(id),
  notification_status text not null default 'pending'
    check (notification_status in ('pending','sent','no_email','failed')),
  notification_sent_at timestamptz,
  notification_error text,
  created_at timestamptz not null default now(),
  unique (payout_id, scout_id)
);

create index if not exists credit_payouts_created_at_idx
  on public.credit_payouts (created_at desc);
create index if not exists credit_payout_lines_scout_idx
  on public.credit_payout_lines (scout_id, created_at desc);

alter table public.guardians enable row level security;
alter table public.scout_guardians enable row level security;
alter table public.credit_payouts enable row level security;
alter table public.credit_payout_lines enable row level security;

drop policy if exists guardians_authenticated_read on public.guardians;
create policy guardians_authenticated_read on public.guardians
  for select to authenticated using (true);
drop policy if exists guardians_coffee_bean_manage on public.guardians;
create policy guardians_coffee_bean_manage on public.guardians
  for all to authenticated
  using (public.has_any_role(array['coffee_bean']::public.app_role[]))
  with check (public.has_any_role(array['coffee_bean']::public.app_role[]));

drop policy if exists scout_guardians_authenticated_read on public.scout_guardians;
create policy scout_guardians_authenticated_read on public.scout_guardians
  for select to authenticated using (true);
drop policy if exists scout_guardians_coffee_bean_manage on public.scout_guardians;
create policy scout_guardians_coffee_bean_manage on public.scout_guardians
  for all to authenticated
  using (public.has_any_role(array['coffee_bean']::public.app_role[]))
  with check (public.has_any_role(array['coffee_bean']::public.app_role[]));

drop policy if exists credit_payouts_authenticated_read on public.credit_payouts;
create policy credit_payouts_authenticated_read on public.credit_payouts
  for select to authenticated using (true);
drop policy if exists credit_payout_lines_authenticated_read on public.credit_payout_lines;
create policy credit_payout_lines_authenticated_read on public.credit_payout_lines
  for select to authenticated using (true);

-- Coffee Beans may correct payout metadata in the portal if needed. Creation is
-- normally performed by the server-side payout function.
drop policy if exists credit_payouts_coffee_bean_manage on public.credit_payouts;
create policy credit_payouts_coffee_bean_manage on public.credit_payouts
  for all to authenticated
  using (public.has_any_role(array['coffee_bean']::public.app_role[]))
  with check (public.has_any_role(array['coffee_bean']::public.app_role[]));
drop policy if exists credit_payout_lines_coffee_bean_manage on public.credit_payout_lines;
create policy credit_payout_lines_coffee_bean_manage on public.credit_payout_lines
  for all to authenticated
  using (public.has_any_role(array['coffee_bean']::public.app_role[]))
  with check (public.has_any_role(array['coffee_bean']::public.app_role[]));

create or replace function public.set_scout_primary_guardian(
  p_scout_id uuid,
  p_first_name text,
  p_last_name text,
  p_email text,
  p_relationship text default 'Parent/Guardian'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_guardian_id uuid;
  v_email text := nullif(lower(btrim(coalesce(p_email,''))), '');
begin
  if v_user_id is null then raise exception 'Authentication is required.'; end if;
  if not public.has_any_role(array['coffee_bean']::public.app_role[]) then
    raise exception 'Only Coffee Beans can manage parent/guardian contacts.';
  end if;
  if not exists (select 1 from public.scouts where id = p_scout_id) then
    raise exception 'Scout not found.';
  end if;

  -- A blank guardian form removes only the primary association; it does not
  -- delete the guardian because the same adult may be linked to siblings.
  if v_email is null and nullif(btrim(coalesce(p_first_name,'')), '') is null
                    and nullif(btrim(coalesce(p_last_name,'')), '') is null then
    delete from public.scout_guardians where scout_id = p_scout_id and is_primary;
    return null;
  end if;

  if v_email is not null then
    select id into v_guardian_id
      from public.guardians
     where lower(email) = v_email
     limit 1;
  end if;

  if v_guardian_id is null then
    insert into public.guardians(first_name,last_name,email,created_by,updated_by)
    values (
      nullif(btrim(coalesce(p_first_name,'')),''),
      nullif(btrim(coalesce(p_last_name,'')),''),
      v_email,
      v_user_id,
      v_user_id
    ) returning id into v_guardian_id;
  else
    update public.guardians
       set first_name = coalesce(nullif(btrim(coalesce(p_first_name,'')),''), first_name),
           last_name  = coalesce(nullif(btrim(coalesce(p_last_name,'')),''), last_name),
           email      = coalesce(v_email, email),
           is_active  = true,
           updated_by = v_user_id,
           updated_at = now()
     where id = v_guardian_id;
  end if;

  update public.scout_guardians
     set is_primary = false
   where scout_id = p_scout_id and is_primary and guardian_id <> v_guardian_id;

  insert into public.scout_guardians(
    scout_id,guardian_id,relationship,is_primary,receive_credit_notifications,created_by
  ) values (
    p_scout_id,v_guardian_id,nullif(btrim(coalesce(p_relationship,'')),''),true,true,v_user_id
  )
  on conflict (scout_id,guardian_id) do update
    set relationship = excluded.relationship,
        is_primary = true,
        receive_credit_notifications = true;

  return v_guardian_id;
end;
$$;

revoke execute on function public.set_scout_primary_guardian(uuid,text,text,text,text) from public, anon;
grant execute on function public.set_scout_primary_guardian(uuid,text,text,text,text) to authenticated;

-- Server-side RPC: atomically reserves scout credits by creating the payout
-- and the transfer_to_pack ledger transactions. The Netlify function verifies
-- the Coffee Bean before invoking this service-role-only function.
create or replace function public.create_credit_payout_draft(
  p_request_key uuid,
  p_created_by uuid,
  p_purpose text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout_id uuid;
  v_payout_number text;
  v_line jsonb;
  v_scout_id uuid;
  v_amount numeric(12,2);
  v_available numeric(12,2);
  v_total numeric(12,2) := 0;
  v_transaction_id uuid;
  v_existing record;
begin
  if p_request_key is null or p_created_by is null then raise exception 'Request and user are required.'; end if;
  if nullif(btrim(coalesce(p_purpose,'')), '') is null then raise exception 'Transfer purpose is required.'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Select at least one scout and amount.';
  end if;

  select * into v_existing from public.credit_payouts where request_key = p_request_key;
  if found then
    return jsonb_build_object('id',v_existing.id,'payout_number',v_existing.payout_number,
      'total_amount',v_existing.total_amount,'status',v_existing.status,
      'stripe_payout_id',v_existing.stripe_payout_id);
  end if;

  v_payout_number := 'TR-' || to_char(current_date,'YYYY') || '-' ||
    lpad(nextval('public.credit_payout_number_seq')::text,4,'0');

  insert into public.credit_payouts(request_key,payout_number,purpose,created_by,updated_by)
  values (p_request_key,v_payout_number,btrim(p_purpose),p_created_by,p_created_by)
  returning id into v_payout_id;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_scout_id := nullif(v_line->>'scout_id','')::uuid;
    v_amount := round(coalesce(nullif(v_line->>'amount','')::numeric,0),2);
    if v_scout_id is null or v_amount <= 0 then raise exception 'Each payout line requires a scout and positive amount.'; end if;

    -- Lock the scout row so two payout requests cannot reserve the same balance concurrently.
    perform 1 from public.scouts where id = v_scout_id and is_active for update;
    if not found then raise exception 'Scout % is missing or inactive.', v_scout_id; end if;

    select coalesce(available_credit,0)::numeric(12,2)
      into v_available
      from public.scout_summary
     where scout_id = v_scout_id;
    v_available := coalesce(v_available,0);

    if v_amount > v_available then
      raise exception 'Requested $% exceeds the available scout credit of $%.', v_amount, v_available;
    end if;

    insert into public.scout_credit_transactions(
      scout_id,transaction_type,amount,transaction_date,purpose,reference_number,notes,created_by,updated_by
    ) values (
      v_scout_id,'transfer_to_pack',v_amount,current_date,btrim(p_purpose),v_payout_number,
      'Stripe payout to Pack bank account',p_created_by,p_created_by
    ) returning id into v_transaction_id;

    insert into public.credit_payout_lines(payout_id,scout_id,amount,transaction_id)
    values (v_payout_id,v_scout_id,v_amount,v_transaction_id);
    v_total := v_total + v_amount;
  end loop;

  update public.credit_payouts set total_amount=v_total,updated_at=now() where id=v_payout_id;

  return jsonb_build_object('id',v_payout_id,'payout_number',v_payout_number,
    'total_amount',v_total,'status','draft');
end;
$$;
revoke execute on function public.create_credit_payout_draft(uuid,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.create_credit_payout_draft(uuid,uuid,text,jsonb) to service_role;

create or replace function public.mark_credit_payout_submitted(
  p_payout_id uuid,
  p_stripe_payout_id text,
  p_arrival_date date default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.credit_payouts
     set status='submitted',stripe_payout_id=p_stripe_payout_id,
         stripe_arrival_date=p_arrival_date,submitted_at=now(),updated_at=now()
   where id=p_payout_id and status='draft';
  if not found then raise exception 'Payout draft not found.'; end if;
end;
$$;
revoke execute on function public.mark_credit_payout_submitted(uuid,text,date) from public, anon, authenticated;
grant execute on function public.mark_credit_payout_submitted(uuid,text,date) to service_role;

create or replace function public.fail_credit_payout_draft(
  p_payout_id uuid,
  p_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.scout_credit_transactions
   where id in (select transaction_id from public.credit_payout_lines where payout_id=p_payout_id and transaction_id is not null)
     and exists (select 1 from public.credit_payouts p where p.id=p_payout_id and p.status='draft');
  update public.credit_payouts
     set status='failed',failure_message=left(coalesce(p_message,'Stripe payout failed.'),1000),updated_at=now()
   where id=p_payout_id and status='draft';
end;
$$;
revoke execute on function public.fail_credit_payout_draft(uuid,text) from public, anon, authenticated;
grant execute on function public.fail_credit_payout_draft(uuid,text) to service_role;

create or replace view public.credit_payout_report as
select
  p.id as payout_id,
  p.payout_number,
  p.purpose,
  p.total_amount,
  p.status,
  p.stripe_payout_id,
  p.stripe_arrival_date,
  p.submitted_at,
  p.paid_at,
  p.created_at,
  l.id as line_id,
  l.amount,
  l.notification_status,
  l.notification_sent_at,
  s.id as scout_id,
  s.first_name as scout_first_name,
  s.last_name as scout_last_name,
  g.first_name as guardian_first_name,
  g.last_name as guardian_last_name,
  g.email as guardian_email
from public.credit_payouts p
join public.credit_payout_lines l on l.payout_id=p.id
join public.scouts s on s.id=l.scout_id
left join public.scout_guardians sg on sg.scout_id=s.id and sg.is_primary
left join public.guardians g on g.id=sg.guardian_id;

grant select on public.credit_payout_report to authenticated;

create or replace function public.update_credit_payout_from_stripe(
  p_stripe_payout_id text,
  p_status text,
  p_failure_message text default null,
  p_arrival_date date default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.credit_payouts
     set status = case when p_status in ('paid','failed','canceled','submitted') then p_status else status end,
         paid_at = case when p_status='paid' then now() else paid_at end,
         failure_message = case when p_status='failed' then p_failure_message else failure_message end,
         stripe_arrival_date = coalesce(p_arrival_date,stripe_arrival_date),
         updated_at=now()
   where stripe_payout_id=p_stripe_payout_id;
end;
$$;
revoke execute on function public.update_credit_payout_from_stripe(text,text,text,date) from public, anon, authenticated;
grant execute on function public.update_credit_payout_from_stripe(text,text,text,date) to service_role;

commit;
