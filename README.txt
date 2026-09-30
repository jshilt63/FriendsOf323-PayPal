Friends of 323 - Orders Page Shipping Workflow

Run this Supabase migration first:
  supabase/migrations/20260828_006_order_shipping_workflow.sql

Then copy the remaining files over the current DeliveryPreview project.

Shipping workflow:
  Coffee Received -> Ready to Ship -> Shipped -> Delivered

Shipping orders display the customer shipping address, carrier, tracking number,
and shipped/delivered timestamps. Mark Shipped requires a carrier and tracking number.
