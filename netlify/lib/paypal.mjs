import { notifyPaidOrder } from './payment-notifications.mjs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
export function paymentEnvironment() {
  const environment = process.env.PAYPAL_ENV || 'sandbox';
  if (!['sandbox', 'live'].includes(environment)) fail('PAYPAL_ENV must be sandbox or live.', 503);
  if (environment === 'live' && process.env.PAYPAL_ENABLE_LIVE !== 'true') fail('Live PayPal payments are not enabled.', 503);
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) fail('PayPal credentials are missing.', 503);
  return environment;
}
export function cents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001) fail('Invalid payment amount.');
  return Math.round(amount * 100);
}
export function response(status, body) { return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}}); }
const base = () => paymentEnvironment() === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
let cachedToken;
export async function paypal(path, {method = 'GET', body, requestId, rawBody} = {}) {
  const config = `${paymentEnvironment()}:${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`;
  if (!cachedToken || cachedToken.config !== config || cachedToken.expires < Date.now()) {
    const res = await fetch(`${base()}/v1/oauth2/token`, {
      method: 'POST', headers: {'Authorization': `Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded'}, body: 'grant_type=client_credentials'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) fail('PayPal authentication failed. Check the sandbox credentials in Netlify.', 502);
    cachedToken = {config, token: data.access_token, expires: Date.now() + Math.max(1, Number(data.expires_in || 300) - 60) * 1000};
  }
  const headers = {'Authorization': `Bearer ${cachedToken.token}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation'};
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const res = await fetch(`${base()}${path}`, {method, headers, ...(body !== undefined || rawBody !== undefined ? {body: rawBody ?? JSON.stringify(body)} : {})});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`PayPal: ${data.details?.[0]?.issue || data.message || 'request failed'}.`, res.status >= 500 ? 502 : 409);
  return data;
}
export async function db(path, {method = 'GET', body, prefer = 'return=representation', userToken} = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!process.env.SUPABASE_URL || !key) fail('Supabase server configuration is missing.', 503);
  const res = await fetch(`${process.env.SUPABASE_URL}${path}`, {
    method, headers: {apikey: key, Authorization: `Bearer ${userToken || key}`, 'Content-Type': 'application/json', Prefer: prefer},
    ...(body !== undefined ? {body: JSON.stringify(body)} : {})
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) fail(data?.message || 'Database request failed. Install supabase/paypal_setup.sql first.', res.status === 409 ? 409 : 500);
  return data;
}
export async function staff(request, allowed = ['coffee_bean']) {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) fail('Sign in to the staff portal.', 401);
  const user = await db('/auth/v1/user', {userToken: token});
  if (!user?.id) fail('Your session has expired.', 401);
  const rows = await db(`/rest/v1/user_profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role,is_active`);
  if (!rows?.[0]?.is_active || !allowed.includes(rows[0].role)) fail('You do not have permission for this action.', 403);
  return user;
}
export const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
export async function checkoutBy(field, value) {
  if (!['id','paypal_order_id','capture_id'].includes(field)) fail('Invalid checkout lookup.');
  const rows = await db(`/rest/v1/paypal_checkouts?${field}=eq.${encodeURIComponent(value)}&environment=eq.${paymentEnvironment()}&limit=1`);
  if (!rows?.[0]) fail('PayPal checkout was not found.', 404);
  return rows[0];
}
function returnToken(row) { return createHmac('sha256', process.env.PAYPAL_CLIENT_SECRET).update(`friends323:${row.environment}:${row.id}:${row.request_key}`).digest('hex'); }
export function verifyReturnToken(row, value) {
  const expected = Buffer.from(returnToken(row)); const actual = Buffer.from(String(value || ''));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail('Payment verification link is invalid.', 403);
}
export function publicCheckout(row) {
  return {checkout_id: row.id, environment: row.environment, status: row.status, store_order_number: row.store_order_number || `SANDBOX-${row.id.slice(0,8).toUpperCase()}`, amount: Number(row.amount), currency: row.currency, capture_id: row.capture_id, refunded_amount: Number(row.refunded_amount || 0)};
}
export async function createPaypalCheckout({request, requestKey, fingerprintPayload, customer, items, coffeeSubtotal, processingCost, shippingAmount, fulfillment}) {
  const environment = paymentEnvironment();
  if (!uuid(requestKey)) fail('A valid checkout request key is required. Refresh the checkout page.');
  const amount = (cents(coffeeSubtotal) + cents(processingCost) + cents(shippingAmount)) / 100;
  if (amount <= 0) fail('The order total must be positive.');
  const fingerprint = createHash('sha256').update(JSON.stringify(fingerprintPayload)).digest('hex');
  const existing = await db(`/rest/v1/paypal_checkouts?request_key=eq.${requestKey}&environment=eq.${environment}&limit=1`);
  let row = existing?.[0];
  if (!row) {
    const saved = await db('/rest/v1/paypal_checkouts?on_conflict=environment,request_key', {method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation', body: {environment, request_key: requestKey, fingerprint, amount, currency: 'USD', payload: {customer, items, processing_cost: processingCost, fulfillment}, status: 'created'}});
    row = saved?.[0] || (await db(`/rest/v1/paypal_checkouts?request_key=eq.${requestKey}&environment=eq.${environment}&limit=1`))[0];
  }
  if (!row || row.fingerprint !== fingerprint) fail('This checkout request was already used for a different cart.', 409);
  if (['completed','refunded','partially_refunded'].includes(row.status)) fail('This checkout already has a payment. Review its payment record instead of paying again.', 409);
  if (Date.now() - Date.parse(row.created_at) > 3 * 60 * 60 * 1000) fail('This checkout attempt expired. Clear the checkout attempt and try again.', 409);
  if (environment === 'live' && !row.order_id) row = await db('/rest/v1/rpc/prepare_paypal_live_order', {method: 'POST', body: {p_checkout_id: row.id}});
  const origin = new URL(request.url).origin;
  const query = `checkout=${row.id}&state=${returnToken(row)}`;
  let order;
  if (row.paypal_order_id) {
    order = await paypal(`/v2/checkout/orders/${encodeURIComponent(row.paypal_order_id)}`);
  } else {
    order = await paypal('/v2/checkout/orders', {method: 'POST', requestId: row.id, body: {
      intent: 'CAPTURE', purchase_units: [{reference_id: row.id, custom_id: row.id, description: `Friends of 323 ${row.store_order_number || 'sandbox coffee order'}`, amount: {currency_code: 'USD', value: Number(row.amount).toFixed(2)}}],
      payment_source: {paypal: {experience_context: {brand_name: 'Friends of 323', user_action: 'PAY_NOW', payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED', shipping_preference: 'NO_SHIPPING', return_url: `${origin}/payment-success.html?${query}`, cancel_url: `${origin}/payment-cancelled.html?${query}`}}}
    }});
    if (!order.id) fail('PayPal did not return an order ID.', 502);
    await db(`/rest/v1/paypal_checkouts?id=eq.${row.id}`, {method: 'PATCH', body: {paypal_order_id: order.id}});
    if (row.order_id) await db(`/rest/v1/orders?id=eq.${row.order_id}`, {method:'PATCH', body:{payment_provider:'paypal',payment_method:'card',payment_session_id:order.id}});
  }
  const link = order.links?.find(link => ['payer-action','approve'].includes(link.rel));
  if (!link?.href) fail('PayPal did not return an approval link.', 502);
  const host = new URL(link.href).hostname;
  if (host !== (environment === 'sandbox' ? 'www.sandbox.paypal.com' : 'www.paypal.com')) fail('Unexpected PayPal approval host.', 502);
  return {...publicCheckout(row), order_id: row.order_id || row.id, order_number: row.store_order_number || `SANDBOX-${row.id.slice(0,8).toUpperCase()}`, payment_method:'online', payment_status:'unpaid', checkout_session_id:order.id, checkout_url:link.href};
}
export async function reconcileCapture(row, order) {
  if (order.id !== row.paypal_order_id || order.purchase_units?.length !== 1 || order.purchase_units[0].custom_id !== row.id) fail('PayPal order does not match the stored checkout.', 409);
  if (['refunded','partially_refunded'].includes(row.status)) return publicCheckout(row);
  const captures = order.purchase_units[0].payments?.captures || [];
  if (captures.length !== 1) fail('PayPal capture is not yet complete.', 409);
  const capture = captures[0];
  if (capture.status !== 'COMPLETED') fail(`PayPal capture is ${capture.status || 'pending'}; no order was marked paid.`, 409);
  if (capture.amount?.currency_code !== row.currency || cents(capture.amount.value) !== cents(row.amount)) fail('Captured payment does not match the checkout total.', 409);
  const fee = capture.seller_receivable_breakdown?.paypal_fee;
  if (fee && fee.currency_code !== row.currency) fail('PayPal fee currency differs from the checkout.', 409);
  const updated = await db('/rest/v1/rpc/complete_paypal_checkout', {method: 'POST', body: {p_checkout_id: row.id, p_paypal_order_id: order.id, p_capture_id: capture.id, p_amount: Number(capture.amount.value), p_currency: capture.amount.currency_code, p_fee: fee ? Number(fee.value) : null}});
  await notifyPaidOrder(updated);
  return publicCheckout(updated);
}
export async function captureCheckout(row) {
  if (['refunded','partially_refunded'].includes(row.status)) return publicCheckout(row);
  let order = await paypal(`/v2/checkout/orders/${encodeURIComponent(row.paypal_order_id)}`);
  if (order.status !== 'COMPLETED') {
    if (order.status !== 'APPROVED') fail('Approve the payment in PayPal before capture.', 409);
    order = await paypal(`/v2/checkout/orders/${encodeURIComponent(row.paypal_order_id)}/capture`, {method:'POST', body:{}, requestId:`capture-${row.id}`});
  }
  return reconcileCapture(row, order);
}
export async function refundCheckout(row, {reason = '', userId = null} = {}) {
  if (!row.capture_id || !['completed','partially_refunded','refunded'].includes(row.status)) fail('This checkout has no completed PayPal capture to refund.',409);
  if (row.status === 'refunded') return publicCheckout(row);
  const refund = await paypal(`/v2/payments/captures/${encodeURIComponent(row.capture_id)}/refund`, {method:'POST', body:{note_to_payer:reason.slice(0,255)}, requestId:`refund-${row.id}`});
  if (refund.status !== 'COMPLETED') fail(`PayPal refund ${refund.id || ''} is ${refund.status || 'pending'}. It has not been marked refunded; check PayPal before retrying.`,409);
  if (!refund.id || refund.amount?.currency_code !== row.currency) fail('PayPal refund response is invalid.',502);
  const updated = await db('/rest/v1/rpc/record_paypal_refund', {method:'POST', body:{p_checkout_id:row.id,p_refund_id:refund.id,p_amount:Number(refund.amount.value),p_currency:refund.amount.currency_code,p_reason:reason,p_user_id:userId}});
  return publicCheckout(updated);
}
