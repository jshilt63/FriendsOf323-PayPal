# Friends of 323 — PayPal Preview

This repository replaces the Stripe checkout, webhook, refund and payout functions with PayPal. The original Stripe repository/site and its historical records remain available. Both sites use the current Supabase project.

## Apply this update

1. Select `Preview` in VS Code. Extract the update ZIP into your repository folder (containing netlify.toml), replacing matching files.
2. In the VS Code PowerShell terminal run `powershell -ExecutionPolicy Bypass -File .\Remove-Legacy-Stripe.ps1`. Review the Source Control changes, commit and Sync Changes.
3. In the existing Friends of 323 Supabase project, run `supabase/paypal_setup.sql` in SQL Editor. This adds payment relationship tables and service-only functions; it does not copy or delete existing data.
4. Keep Netlify Functions variables `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_ENV=sandbox` configured for Branch deploys. Client ID and secret must belong to the Sandbox app. Leave `PAYPAL_ENABLE_LIVE` unset.
5. In the PayPal Sandbox app, add a webhook for your actual Preview URL: `https://YOUR-PREVIEW-HOST/.netlify/functions/paypal-webhook`. Subscribe to `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED` and `CHECKOUT.ORDER.COMPLETED`. Set its generated webhook ID as Netlify `PAYPAL_WEBHOOK_ID`, then redeploy Preview.

No GitHub changes have been pushed by this update. The SQL has been tested against a local PostgreSQL fixture, but has not been applied to your database.

## Sandbox testing

Choose coffee and a Scout, check out through PayPal, and sign in using a PayPal Sandbox personal buyer account. Complete the sandbox payment and return to the site. The success page verifies capture on the server before confirming payment. See Administration → PayPal Payments, select Sandbox, and inspect the payment and actual fee. A Coffee Bean can issue a sandbox refund there. Also test cancellation, return-page retries and duplicate webhook delivery.

Sandbox checkout writes only the new PayPal payment tables. It does not create production orders, mark existing orders paid, award Scout credits, or send payment emails. Staff administration, cash orders, supplier emails, shipping labels and manual credit adjustments still use the shared real records and existing configured services.

## Transfers and history

Transfers to Pack records a transfer you have already completed in PayPal or your bank, with its actual reference, date and Scout allocations. It does not initiate a withdrawal. Existing credit-balance checks and historical reports remain. Supplier funding offsets and Stripe balance/payout actions have been removed. Historical Stripe orders remain readable; refund them through the original Stripe system.

## Live checkout

Live is disabled by default and requires both `PAYPAL_ENV=live` and `PAYPAL_ENABLE_LIVE=true`, plus live app credentials and a live webhook ID. Before enabling it, complete real sandbox testing and verify the existing production schema against the additive setup. Live capture updates the existing order/credit workflow; live refunds reverse the payment through PayPal. Keep the original Stripe deployment available for legacy payments.

## Verification

Run `npm ci` then `npm test`. Tests mock PayPal/Supabase HTTP calls and use a local PostgreSQL fixture. They cover authoritative pricing, retry safety, capture validation, webhook verification, refunds, sandbox isolation, SQL replay, credit limits and transfer retries. They do not demonstrate a completed transaction against your deployed Sandbox app.
