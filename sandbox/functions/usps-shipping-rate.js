// Placeholder: never invoke the copied Stripe backend from the test deployment.
exports.handler = async () => ({
  statusCode: 503,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify({ error: "PayPal sandbox integration is being prepared. No payment or database change was made." })
});
