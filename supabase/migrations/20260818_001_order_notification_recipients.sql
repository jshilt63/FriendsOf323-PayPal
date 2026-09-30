begin;

-- ============================================================
-- Friends of 323
-- Order Notification Recipients
--
-- Adds a checkbox-backed flag to portal users.
-- Active portal users with this flag enabled are eligible to
-- receive paid-order notifications.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Add notification preference to portal profiles.
-- ------------------------------------------------------------

alter table public.user_profiles
    add column if not exists receive_order_notifications boolean
        not null
        default false;


-- ------------------------------------------------------------
-- 2. Initially enable the Coffee Bean mailbox requested for
--    order notifications.
--
-- user_profiles.id corresponds to auth.users.id.
-- If the user does not yet exist, this safely updates zero rows.
-- ------------------------------------------------------------

update public.user_profiles up
set
    receive_order_notifications = true,
    updated_at = now()
from auth.users au
where au.id = up.id
  and lower(trim(au.email)) = lower('coffee_bean@lspack323.com');


-- ------------------------------------------------------------
-- 3. Server-only recipient lookup for the later email function.
--
-- This returns only ACTIVE users who have opted in.
-- Email comes from Supabase Auth because user_profiles does not
-- store a separate email address.
-- ------------------------------------------------------------

create or replace function public.get_order_notification_recipients()
returns table (
    user_id uuid,
    display_name text,
    email text
)
language sql
security definer
stable
set search_path = ''
as $function$

    select
        up.id as user_id,
        nullif(trim(up.display_name), '') as display_name,
        lower(trim(au.email)) as email

    from public.user_profiles up

    join auth.users au
      on au.id = up.id

    where up.is_active = true
      and up.receive_order_notifications = true
      and nullif(trim(coalesce(au.email, '')), '') is not null

    order by
        lower(
            coalesce(
                nullif(trim(up.display_name), ''),
                au.email
            )
        );

$function$;


-- ------------------------------------------------------------
-- 4. Keep recipient lookup server-only.
--
-- The future paid-order Netlify function/webhook can call this
-- using SUPABASE_SERVICE_ROLE_KEY.
-- ------------------------------------------------------------

revoke all
on function public.get_order_notification_recipients()
from public;

revoke all
on function public.get_order_notification_recipients()
from anon;

revoke all
on function public.get_order_notification_recipients()
from authenticated;

grant execute
on function public.get_order_notification_recipients()
to service_role;


commit;


-- ============================================================
-- Verification
-- ============================================================

select
    c.column_name,
    c.data_type,
    c.is_nullable,
    c.column_default
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name = 'user_profiles'
  and c.column_name = 'receive_order_notifications';


select
    user_id,
    display_name,
    email
from public.get_order_notification_recipients();
