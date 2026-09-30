Friends of 323 - Order Delivery Eligibility build

1. Run supabase/migrations/20260828_002_order_delivery_eligibility.sql in Supabase.
2. Copy/deploy the remaining files using the same relative paths.
3. Sign in as Coffee Bean and open Committee Portal > Orders.
4. Active, undelivered orders are automatically compared with all active driver delivery areas.
5. The Delivery Option column shows Local Delivery, Shipping Required, No Address, or Address Check Failed.
6. Open an order to see every matching delivery area and distance.
7. Recheck Delivery forces a fresh route comparison. Existing geocoded coordinates are reused unless the customer address changed.

This build does not assign a driver and does not change order delivery_status.
