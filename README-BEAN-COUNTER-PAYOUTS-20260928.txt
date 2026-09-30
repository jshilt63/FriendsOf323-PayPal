Friends of 323 — Bean Counter, Pack bank deposits, and roaster funding

Database: migrations 20260928_003 through 20260928_007 have been applied to the Friends of 323 Supabase project. Include the SQL files in source control; apply them in order to any other project or preview database. Migration 001/002 created the earlier tracking foundation.

Deploy the updated site and Netlify functions. Keep STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, and SUPABASE_SECRET_KEY configured. The existing Stripe webhook must receive payout.paid, payout.failed, and payout.canceled events.

Assign the Bean Counter role to the Treasurer under Administration > Users. She signs in to Bean Counter, confirms a full cash or Venmo order payment, and records the Pack checking deposit reference once deposited. The Coffee Bean can also access that page.

Create Pack Payout now shows the selected Scout credit total, the amount already in Pack checking, and the remaining Stripe payout. Bank deposits cannot be used twice. A zero Stripe amount records a bank-only Scout credit application without calling the Stripe payout API. Failed Stripe payouts restore the Scout credits and free the offset.

Administration > Roaster has a Roaster Funding Payout toggle, off by default. When enabled, a submitted purchase order offers Fund Roaster via Pack Bank. This initiates a separate Stripe payout for that PO's roaster cost to Pack checking. It does not pay the roaster directly and does not consume Scout credit. Once Pack debit cards are available, turn the toggle off. No Stripe payout is initiated by installing or deploying these files.
