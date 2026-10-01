HISTORICAL STRIPE DOCUMENT: This workflow is no longer used in the PayPal repository. See README-PAYPAL-TESTING.md.

Friends of 323 — Scout Credit Payout Workflow
2026-08-24

INSTALL ORDER
1. In Supabase SQL Editor run:
   supabase/migrations/20260824_003_scout_payouts_and_guardians.sql

2. Deploy this site to the main Friends of 323 Netlify site.

3. Confirm existing Netlify environment variables remain present:
   STRIPE_SECRET_KEY
   STRIPE_WEBHOOK_SECRET
   SUPABASE_URL
   SUPABASE_SERVICE_ROLE_KEY
   GMAIL_USER
   GMAIL_APP_PASSWORD

4. In the LIVE Stripe webhook endpoint for:
   https://friendsof323.netlify.app/.netlify/functions/stripe-webhook
   add these payout events in addition to the existing Checkout events:
   payout.paid
   payout.failed
   payout.canceled

WHAT WAS ADDED
- Parent/guardian records that may be shared by sibling Scouts.
- Primary parent/guardian fields on Scout administration.
- Scout-by-scout partial payout selection.
- Purpose/item name for each Pack payout.
- One Stripe payout for the combined selected Scout amounts.
- Automatic parent congratulatory emails when a payout is submitted.
- Notification audit per Scout payout line.
- Stripe payout status tracking.
- Treasurer payout report with Scout allocations and Print / Save PDF.

SCOUTS WITHOUT EMAIL
A missing parent email does not block the payout. The payout line is marked
"no_email" so the contact can be added later.

IMPORTANT
Stripe must have enough AVAILABLE balance to cover the requested payout.
If Stripe rejects the payout, the reserved Scout credit transactions are removed
and the payout is marked failed.
