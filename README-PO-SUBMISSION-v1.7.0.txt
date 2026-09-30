Friends of 323 — Purchase Order Submit Process (v1.7.0)

1. In Supabase SQL Editor run:
   supabase/migrations/20260828_003_purchase_order_pdf_submission.sql

   This adds:
   - purchase-order email/PDF audit fields
   - supplier PO email settings
   - private Supabase Storage bucket: purchase-orders

2. Deploy this site to Netlify.

No new Netlify email variables are required. The Submit PO function reuses:
- GMAIL_USER
- GMAIL_APP_PASSWORD

It also uses the existing Supabase server variables:
- SUPABASE_URL
- SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)

Submit workflow:
- Draft PO shows Submit PO.
- Enter/confirm roaster PO email.
- Server generates final PDF sorted by SKU.
- Exact PDF is uploaded to private Supabase Storage.
- That same PDF is attached to the roaster email.
- On success, the PO becomes Submitted and draft editing is locked.
- On failure, the PO remains Draft and records the error for retry.
- Submitted POs show View Submitted PDF to retrieve the archived copy.
