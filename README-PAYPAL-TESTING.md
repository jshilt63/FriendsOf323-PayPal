# Friends of 323 — PayPal development site

This repository develops the PayPal transition while the current Stripe repository and Netlify site continue independently. Both sites use the existing Supabase project `vwzzupezgiffqgmmhxed`.

## Current access

At the owner's request, the shop feeds and staff functions are restored. `netlify.toml` deploys the original `netlify/functions` directory. The portal connects to existing Supabase Auth and application tables without the earlier sandbox readiness gate. Existing authentication, roles, and RLS still apply.

Edits, cash receipts, adjustments, supplier submissions, and other staff actions affect real shared records. This is not a copied database. The old placeholder directory `sandbox/functions` is no longer deployed.

Online checkout stops at the final payment step with `PAYPAL_CHECKOUT_NOT_READY`, before creating customers/orders or contacting Stripe. PayPal create/capture/webhook integration is not implemented yet. Cash orders follow the existing workflow and create actual unpaid orders and send their usual notifications when configured.

Existing Stripe payout and refund features are still Stripe features. They require Stripe credentials and can move real funds. They have not been relabeled or converted to PayPal. Supplier emails and shipping labels also use real services when configured. Restoring access does not mean any of these actions have been executed by this update.

## Netlify configuration

Keep the new Netlify site connected only to `jshilt63/FriendsOf323-PayPal`, branch `Preview` for this development update. Leave the current Stripe site's repository mapping unchanged.

Set `SUPABASE_URL` to the existing project URL and `SUPABASE_SERVICE_ROLE_KEY` to that project's server-only key in the new Netlify site's function environment. Never put the service-role key in source or browser files. Product/Scout feeds require these variables; staff browser login uses the public configuration in `sandbox-config.js`.

Other staff backend functions need the same environment variable names they use on the current site. Missing configuration results in their normal errors. No new Netlify environment variables were set by this code update.

PayPal app credentials (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`) must be sandbox credentials during development. `PAYPAL_ENV=sandbox` remains configured. Sandbox funds cannot fund the real debit card.

## Update your local working copy

Select branch `Preview` in VS Code. Extract the accompanying update ZIP into the working repository folder (the one containing `store.html` and `netlify.toml`), replacing its matching files. Commit the changes and Publish Branch / Sync Changes. GitHub did not accept the connector write, so this update has not been published remotely. In Netlify, deploy branch `Preview` after it is published.

## Remaining implementation

- Replace inherited Stripe online checkout with PayPal sandbox create/capture, server-side pricing, verified webhooks, idempotency, reconciliation, and refunds.
- Add provider-neutral payment relationships alongside current order records, preserving historical Stripe IDs and compatibility.
- Keep PayPal sandbox payment activity separate from production payment status and Scout credits, even though staff administration uses shared live tables.
- Remove the Stripe-specific roaster funding and payout workarounds in the PayPal version while retaining history, cash accounting, supplier obligations, and Scout/General Fund allocations.
- Test failed, canceled, duplicate, delayed-webhook, refund and successful payments before enabling live PayPal checkout.

No production schema changes or actual purchases, payouts, refunds, supplier emails, or labels were executed as part of restoring access.
