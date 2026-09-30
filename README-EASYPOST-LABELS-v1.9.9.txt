FRIENDS OF 323 — EASYPOST CARRIER LABEL PRINTING v1.9.9

WHAT CHANGED
- Orders now buy/retrieve the saved EasyPost carrier label instead of creating the old Avery address label.
- Existing EasyPost labels are reused, preventing duplicate postage purchases.
- Test orders generate test labels; production orders purchase real postage.
- The complete 4 x 6 carrier label is printed at full size inside a branded Friends of 323 / Heritage Coffee frame on a letter-size page.
- Tracking number and carrier are saved back to the order after EasyPost label purchase.
- Coffee Bean and Barista roles may buy/print labels; Cupper remains read-only.
- Batch label printing prepares one branded page per selected shipment.

IMPORTANT
This feature uses the EasyPost shipment ID and rate ID saved when checkout calculated shipping. Orders that were not rated by EasyPost do not automatically purchase a carrier label.

NETLIFY ENVIRONMENT
Existing EasyPost variables are used:
EASYPOST_API_ENVIRONMENT
EASYPOST_TEST_API_KEY
EASYPOST_PRODUCTION_API_KEY

No new Supabase migration is required for this change.
