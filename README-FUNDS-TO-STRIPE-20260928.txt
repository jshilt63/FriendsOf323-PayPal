HISTORICAL STRIPE DOCUMENT: This workflow is no longer used in the PayPal repository. See README-PAYPAL-TESTING.md.

Friends of 323 — cash and Venmo funds tracking

1. Apply supabase/migrations/20260928_001_track_funds_to_stripe.sql if it is not already installed. Apply 20260928_002_correct_funding_order_total.sql for installations that used the initial version of 001. The live Friends of 323 database received the 002 correction on September 28, 2026.
2. Deploy the updated repository to Netlify.
3. On an unpaid order, record the actual payment method (cash or Venmo) and mark the order paid after the payment is confirmed.
4. Under Administration > Funds to Stripe, record when the Treasurer has the proceeds. Select one or more received orders, enter the reference supplied by the Treasurer after they initiate a bank-to-Stripe transfer, and record it as initiated.
5. After the balance arrives in Stripe, choose Confirm in Stripe to mark the transfer complete.

This page is an audit record only. It does not initiate a bank transfer or a card payment. The Treasurer initiates the actual transfer from the Pack bank account in Stripe. An order can be assigned to one transfer only.

The separate Administration > Roaster page stores each supplier's email, and purchase order submission retrieves it on the server. Netlify still requires GMAIL_USER and GMAIL_APP_PASSWORD for emailing the PDF.
