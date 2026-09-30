# Friends of 323 — separate PayPal development repository

This is the uploaded September 30, 2026 working tree, copied into a new Git repository with no remote pointing to the current Stripe repository. PayPal checkout is not implemented yet. The original Stripe repository and live deployment are unchanged.

## Import into GitHub

Create an empty PRIVATE repository named `FriendsOf323-PayPal` under `jshilt63`. Do not initialize it with a README, license, or gitignore.

The accompanying Git bundle includes the initial commit. In Windows PowerShell:

```powershell
cd C:\Development
git clone .\FriendsOf323-PayPal.bundle FriendsOf323-PayPal
cd FriendsOf323-PayPal
git remote remove origin
git remote add origin https://github.com/jshilt63/FriendsOf323-PayPal.git
git push -u origin main
```

Download/extract this package to `C:\Development` first. The `source` folder is also supplied for inspection; use the bundle commands to retain its prepared commit.

## Separate test services

1. Create a NEW Netlify site connected only to `FriendsOf323-PayPal`. Do not reconnect or alter the existing live site.
2. Create a separate Supabase test project or isolated development branch. Populate it with schema and synthetic products, scouts, users, and orders. Do not import customer personal details or reuse live auth/users. Existing migration files are historical and may depend on original schema not included in this ZIP; do not blindly replay them against an empty project.
3. Add only that test project's public URL/key to `sandbox-config.js`; its secret service-role key belongs only in the new Netlify site's environment variables.
4. In PayPal Developer, create a sandbox application and use virtual business and buyer accounts. Add sandbox credentials to the test site's environment variables. Sandbox funds cannot fund the real debit card.
5. Keep real email and shipping label purchases disabled during testing.

## Current deployment behavior

`netlify.toml` deploys only `sandbox/functions`. All copied backend endpoints there return 503, so this foundation cannot charge customers, issue refunds, send payouts, email suppliers, buy labels, or modify orders through those functions. The original functions in `netlify/functions` are reference code and are NOT the deployed functions directory. The portal refuses to connect until a separate database is configured and explicitly rejects the current production project hostname.

## Next implementation

- Replace Stripe checkout with PayPal sandbox create/capture, server-side amount validation, verified webhooks, idempotency, and payment reconciliation.
- Remove Roaster Funding Payout and Stripe balance/payout dependencies from this new version.
- Keep cash receipt/deposit accounting, supplier obligations, Scout/General Fund allocations, audit history, and existing transaction references.
- Record PayPal-to-Pack transfers against actual completed transfers; never relabel a Stripe payout call as a PayPal transfer.
- Adapt processing fees and refunds to the actual PayPal method/fees.
- Test successful, declined, canceled, duplicate, delayed-webhook, partial/refund, cash, supplier-payment recording, and Scout transfer cases.
- Switch live only after separate testing and a controlled real transaction. Debit-card supplier payment requires a later live test; it cannot be proven with sandbox funds.

No production database migrations or account changes have been made by this package.
