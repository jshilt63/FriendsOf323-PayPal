Friends of 323 — EasyPost shipping update (v1.9.8)

Changes
- Customer shipping charge now uses the EasyPost USPS Ground Advantage account rate.
- Adds a configurable packaging charge in Administration > Shipping (default $2.00).
- Customer shipping = EasyPost account postage + packaging charge.
- EasyPost Rate Test shows postage, packaging, customer total, and USPS retail comparison.
- Shipping packages can now be deleted from Edit Shipping Package using a custom confirmation dialog.

Migration to run
- supabase/migrations/20260904_002_shipping_packaging_charge.sql

Existing Netlify variables remain unchanged.
For testing keep EASYPOST_API_ENVIRONMENT=test.
