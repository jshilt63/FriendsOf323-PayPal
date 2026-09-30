FRIENDS OF 323 — STORE NOTICE v1.9.6
=====================================

WHAT CHANGED
- Adds Administration -> Store Notice.
- Coffee Bean administrators can enable/disable the customer notice.
- Heading and message are editable for reuse.
- When enabled, the store shows a persistent notice banner.
- Customers also see an entrance dialog once per browser session.
- Editing the notice updates storefront_settings.updated_at, so the revised notice is shown again.

DEFAULT NOTICE
Heading: Our Bean Acquisition Clerk Is On Vacation
Message: Due to a minor organizational oversight, it appears our Bean Acquisition Clerk is also a critical component of our entire coffee supply chain. While he is away, orders can still be placed as usual, but procurement, processing, and delivery may take a little longer than normal. Apparently, we should have cross-trained someone.

REQUIRED DATABASE STEP
Run this migration in Supabase SQL Editor before testing the new Administration tab:
  supabase/migrations/20260831_001_store_announcement.sql

DEPLOYMENT
After the SQL migration succeeds, deploy the site normally to Netlify. The new public Netlify function is:
  netlify/functions/store-announcement.mjs

TEST
1. Administration -> Store Notice.
2. Confirm the default heading/message appear.
3. Turn Enable store notice ON.
4. Open store.html in a new browser session/incognito window.
5. Confirm the modal appears and the banner remains after closing it.
6. Refresh in the same session: banner remains, modal does not reappear.
7. Turn the setting OFF and refresh the store: both are gone.
