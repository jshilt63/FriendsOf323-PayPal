Friends of 323 PayPal checkout update - October 2, 2026

Extract the contents into the root of your FriendsOf323-PayPal repository while on the Preview branch. Allow replacement of the existing files, then review and Sync Changes in VS Code.

Changes:
- Online order/handling fee remains OPTIONAL. Add/remove controls and checkout checkbox remain available.
- Gross-up calculation: customer total = (coffee subtotal + $0.49) / (1 - 0.0349). Fee = customer total - coffee subtotal, rounded up to the nearest cent. $30 coffee subtotal gives a $1.60 optional fee.
- Cash orders have no online order/handling fee.
- Updated customer checkout and PayPal payment confirmation email labels.
- Preserves one-time CAPTURE, PAY_NOW, and IMMEDIATE_PAYMENT_REQUIRED. No subscription or recurring payment is created.

PayPal limitation:
This integration uses PayPal hosted redirect checkout, not the JavaScript SDK. The SDK disable-funding=paylater,credit setting does not apply to this redirect. Immediate-payment settings were already present and are preserved; they do not guarantee PayPal hides financing choices inside the buyer wallet. Do not interpret this ZIP as disabling all wallet financing.

No SQL or environment variable changes are required.
Validation: JavaScript syntax checks and all 8 existing PayPal checkout tests passed. No real payment was made.
