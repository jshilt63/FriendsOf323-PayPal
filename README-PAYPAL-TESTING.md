# Friends of 323 — separate PayPal development repository

This is the uploaded September 30, 2026 working tree, copied into a new Git repository with no remote pointing to the current Stripe repository. PayPal checkout is not implemented yet. The original Stripe repository and live deployment are unchanged.

## Import into GitHub

Create an empty PRIVATE repository named `FriendsOf323-PayPal` under `jshilt63`. Do not initialize it with a README, license, or gitignore.

The accompanying Git bundle includes the baseline and shared-database approach update. In Windows PowerShell:

```powershell
cd C:\Development
git clone .\FriendsOf323-PayPal.bundle FriendsOf323-PayPal
cd FriendsOf323-PayPal
git remote remove origin
git remote add origin https://github.com/jshilt63/FriendsOf323-PayPal.git
git push -u origin main
```

Download/extract this package to `C:\Development` first. The `source` folder is also supplied for inspection; use the bundle commands to retain its prepared commit.

## Shared Supabase project, separate test site

1. Create a NEW Netlify site connected only to `FriendsOf323-PayPal`. Keep the existing Stripe repository and live site operational.
2. Keep the existing Supabase project (`vwzzupezgiffqgmmhxed`). No historical-data migration or staff-account migration is needed for this approach.
3. Add dedicated sandbox tables in that project for synthetic orders, items, payments, refunds, and sandbox credit calculations. Do not attach sandbox payments to real orders. Use explicit grants and RLS, and have every backend operation validate its environment. These tables and routing are planned; they have NOT been installed by this package.
4. Reuse existing Supabase Auth identities with the existing staff role checks, plus authorization for sandbox data. Keep test browser sessions under a separate storage key.
5. In PayPal Developer, create a sandbox application and virtual business and buyer accounts. Add sandbox credentials only to the new site's environment variables. Sandbox funds cannot fund the real debit card.
6. Keep real email, supplier submissions, payouts, and shipping label purchases disabled during testing. Do not copy those live credentials into the test site.

## Current deployment behavior

`netlify.toml` deploys only `sandbox/functions`. All placeholder backend endpoints return 503 without invoking the copied Stripe functions. The original functions in `netlify/functions` remain reference code.

The public shared-project URL/key are now configured in `sandbox-config.js`. The portal deliberately remains paused by `sandboxDataReady: false`, because the copied portal still contains direct writes to live tables. Do not flip this flag to enable the old portal: first implement and verify sandbox routing throughout the client and backend. A new repository alone does not isolate database writes.

## Payment relationships for the live transition

Add provider-neutral payment records linked to existing orders, with Stripe/PayPal provider, environment, provider transaction ID, amount/currency, actual fees, and status. Track refunds and verified webhook events separately with unique provider/environment/event IDs to prevent duplicate processing. Existing Stripe columns and references remain in place for compatibility and reconciliation.

Sandbox relationships point only to sandbox orders in separate tables. Live relationships point to existing production orders after release. Sandbox capture/webhook handlers must never update production orders, Scout credits, roaster obligations, or bank-deposit allocations.

Changes will be additive while Stripe runs. Backfill historical Stripe relationships only after inspecting the live schema and reconciling totals; never recapture or charge historical orders. Keep production legacy structures until the current Stripe site no longer depends on them.

## Next implementation

- Implement isolated sandbox data access and authorization before enabling the test portal.
- Replace Stripe checkout with PayPal sandbox create/capture, server-side amount validation, verified webhooks, idempotency, and payment reconciliation.
- Remove Roaster Funding Payout and Stripe balance/payout dependencies from this new version.
- Keep cash receipt/deposit accounting, supplier obligations, Scout/General Fund allocations, audit history, and existing transaction references.
- Record PayPal-to-Pack transfers against actual completed transfers; never relabel a Stripe payout call as a PayPal transfer.
- Adapt processing fees and refunds to the actual PayPal method/fees.
- Test successful, declined, canceled, duplicate, delayed-webhook, partial/refund, cash, supplier-payment recording, and Scout transfer cases.
- Switch live only after separate testing and a controlled real transaction. Debit-card supplier payment requires a later live test; it cannot be proven with sandbox funds.

No production database migrations or account changes have been made by this package.
