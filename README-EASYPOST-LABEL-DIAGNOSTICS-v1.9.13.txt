FRIENDS OF 323 - EASYPOST LABEL DIAGNOSTICS v1.9.13

Changes:
- Shows label progress stages: Authenticating, Contacting EasyPost label service, validating label, preparing print.
- Supabase session lookup now times out after 12 seconds with a visible error.
- easypost-shipping-label request now times out after 30 seconds with a visible error.
- Browser requires a returned label_url before printing. A tracking number by itself is not treated as proof that postage exists.
- Server-side label function already verifies the actual EasyPost shipment and only reuses it when postage_label.label_url exists.
