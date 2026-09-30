-- Friends of 323
-- Reusable storefront announcement controlled from Administration.

begin;

alter table public.storefront_settings
  add column if not exists announcement_enabled boolean not null default false,
  add column if not exists announcement_title text not null default 'Our Bean Acquisition Clerk Is On Vacation',
  add column if not exists announcement_message text not null default 'Due to a minor organizational oversight, it appears our Bean Acquisition Clerk is also a critical component of our entire coffee supply chain. While he is away, orders can still be placed as usual, but procurement, processing, and delivery may take a little longer than normal. Apparently, we should have cross-trained someone.';

update public.storefront_settings
set announcement_title = coalesce(nullif(announcement_title, ''), 'Our Bean Acquisition Clerk Is On Vacation'),
    announcement_message = coalesce(nullif(announcement_message, ''), 'Due to a minor organizational oversight, it appears our Bean Acquisition Clerk is also a critical component of our entire coffee supply chain. While he is away, orders can still be placed as usual, but procurement, processing, and delivery may take a little longer than normal. Apparently, we should have cross-trained someone.')
where id = 1;

commit;
