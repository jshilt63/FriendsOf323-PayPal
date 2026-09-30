Friends of 323 v1.8.6 - Batch Shipping Labels

Before testing:
1. Run supabase/migrations/20260830_001_shipping_label_print_status.sql in Supabase SQL Editor.
2. Deploy the project.

New behavior:
- Orders page includes Print Shipping Labels.
- Select multiple active shipping orders for one print job.
- Mark unavailable positions on the first Avery 94256 sheet.
- Additional pages automatically use all four label positions.
- Ready-to-Ship labels that have not been printed are selected by default.
- Orders with incomplete shipping addresses cannot be selected.
- A Label Printed date/time is stored and shown in the Orders grid and Order Details.
- Individual Print Shipping Label also records Label Printed status.
