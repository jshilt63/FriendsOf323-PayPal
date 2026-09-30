Friends of 323 — EasyPost USPS Ground Advantage integration (v1.9.7)

Environment variables already expected in Netlify:
  EASYPOST_TEST_API_KEY
  EASYPOST_PRODUCTION_API_KEY
  EASYPOST_RATING_ENABLED=true
  EASYPOST_API_ENVIRONMENT=test   (switch to production after validation)

Database:
Run supabase/migrations/20260904_001_easypost_shipping_rating.sql before deploying this version.

What changed:
- EasyPost replaces the staged direct-USPS API path for shipping-rate calculation.
- USPS Ground Advantage is selected from EasyPost rates.
- Customer charge uses EasyPost's USPS retail_rate because postage is currently purchased separately at the Post Office.
- Package dimensions and empty-package weight come from Administration > Shipping Packages.
- Coffee contents weight is calculated from product bag_size (for example 12oz or 16oz).
- If EasyPost is disabled, package measurements are incomplete, or EasyPost fails, the configured package fallback rate is used when one exists.
- Checkout recalculates the rate server-side before creating Stripe Checkout.
- Administration > Shipping includes an EasyPost Rate Test form.
- Order rows store EasyPost/fallback rating metadata for later review.

Testing sequence:
1. Run the migration.
2. Deploy with EASYPOST_API_ENVIRONMENT=test.
3. In Administration > Shipping, complete the return address.
4. Enter dimensions and empty weight for at least one Shipping Package.
5. Use EasyPost Rate Test with a destination ZIP and coffee contents weight.
6. Test a storefront shipping checkout and verify the displayed shipping amount matches the Stripe shipping line.
7. After package measurements and several destinations are verified, set EASYPOST_API_ENVIRONMENT=production.
