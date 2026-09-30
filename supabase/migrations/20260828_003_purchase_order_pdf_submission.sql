-- Friends of 323 Coffee Portal
-- Submit PO with archived PDF + email audit trail
-- 2026-08-28

begin;

alter table public.purchase_orders
  add column if not exists submission_email text,
  add column if not exists pdf_storage_path text,
  add column if not exists pdf_generated_at timestamptz,
  add column if not exists email_status text not null default 'not_sent',
  add column if not exists email_sent_at timestamptz,
  add column if not exists email_error text,
  add column if not exists submitted_by uuid references auth.users(id);

do $$
begin
  alter table public.purchase_orders
    add constraint purchase_orders_email_status_check
    check (email_status in ('not_sent','processing','sent','failed'));
exception when duplicate_object then null;
end $$;

create table if not exists public.purchase_order_supplier_settings (
  supplier_name text primary key,
  po_email text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint po_supplier_settings_name_required check (length(trim(supplier_name)) > 0),
  constraint po_supplier_settings_email_valid check (
    po_email is null or po_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  )
);

create unique index if not exists purchase_order_supplier_settings_name_ci
  on public.purchase_order_supplier_settings(lower(trim(supplier_name)));

drop trigger if exists purchase_order_supplier_settings_set_updated_at
  on public.purchase_order_supplier_settings;
create trigger purchase_order_supplier_settings_set_updated_at
before update on public.purchase_order_supplier_settings
for each row execute function public.set_updated_at();

alter table public.purchase_order_supplier_settings enable row level security;

drop policy if exists purchase_order_supplier_settings_read on public.purchase_order_supplier_settings;
create policy purchase_order_supplier_settings_read
on public.purchase_order_supplier_settings for select to authenticated
using (public.is_active_user());

drop policy if exists purchase_order_supplier_settings_write on public.purchase_order_supplier_settings;
create policy purchase_order_supplier_settings_write
on public.purchase_order_supplier_settings for all to authenticated
using (public.has_any_role(array['coffee_bean']::public.app_role[]))
with check (public.has_any_role(array['coffee_bean']::public.app_role[]));

grant select, insert, update on public.purchase_order_supplier_settings to authenticated;

-- The browser never reads this bucket directly. Netlify functions use the
-- Supabase service key to archive/retrieve the exact PDF sent to the roaster.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('purchase-orders', 'purchase-orders', false, 10485760, array['application/pdf'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

commit;
