const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

exports.handler = async function handler(event) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };

  if (event.httpMethod !== "POST") {
    return response(405, { error: "Method not allowed." }, headers);
  }

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !STRIPE_SECRET_KEY) {
    return response(500, { error: "Refund configuration is incomplete." }, headers);
  }

  try {
    const token = getBearerToken(event.headers.authorization || event.headers.Authorization);
    const caller = await verifyUser(token);
    const profile = await getProfile(caller.id);

    if (!profile?.is_active || profile.role !== "coffee_bean") {
      return response(403, { error: "Coffee Bean access is required." }, headers);
    }

    const body = JSON.parse(event.body || "{}");
    const orderId = String(body.order_id || "").trim();
    const reason = String(body.reason || "").trim();

    if (!orderId) return response(400, { error: "Order ID is required." }, headers);
    if (!reason) return response(400, { error: "A cancellation reason is required." }, headers);

    const order = await getOrder(orderId);
    if (!order) return response(404, { error: "Order was not found." }, headers);

    if (order.record_status !== "active") {
      return response(400, { error: "Only an active order can be cancelled and refunded." }, headers);
    }
    if (order.payment_provider !== "stripe" || order.payment_status !== "paid") {
      return response(400, { error: "This order does not have a paid Stripe payment to refund." }, headers);
    }

    let paymentIntentId = String(order.payment_transaction_id || "").trim();

    if (!paymentIntentId && order.payment_session_id) {
      const session = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(order.payment_session_id)}`);
      paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : "";
    }

    if (!paymentIntentId) {
      return response(409, {
        error: "Stripe payment information is missing for this order. No refund was attempted."
      }, headers);
    }

    const refundParams = new URLSearchParams();
    refundParams.set("payment_intent", paymentIntentId);
    refundParams.set("reason", "requested_by_customer");
    refundParams.set("metadata[order_id]", order.id);
    refundParams.set("metadata[order_number]", String(order.order_number || ""));
    refundParams.set("metadata[store_order_number]", String(order.store_order_number || ""));
    refundParams.set("metadata[cancelled_by]", caller.id);

    const refund = await stripePost("/v1/refunds", refundParams, `friends323-refund-${order.id}`);

    const refundedAmount = Number(refund.amount || 0) / 100;
    const now = new Date().toISOString();

    const patch = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(order.id)}`,
      {
        method: "PATCH",
        headers: {
          ...adminHeaders(),
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          record_status: "voided",
          void_reason: reason,
          voided_by: caller.id,
          voided_at: now,
          updated_by: caller.id,
          payment_status: "refunded",
          amount_paid: 0,
          refund_transaction_id: refund.id,
          refunded_amount: refundedAmount,
          refunded_at: now
        })
      }
    );

    const patched = await parseJson(patch);
    if (!patch.ok) {
      console.error("Stripe refund succeeded but order update failed", {
        order_id: order.id,
        refund_id: refund.id,
        details: patched
      });
      return response(500, {
        error: `Stripe refund ${refund.id} succeeded, but the Friends of 323 order could not be updated. Check Stripe before retrying.`,
        refund_id: refund.id
      }, headers);
    }

    return response(200, {
      success: true,
      refund_id: refund.id,
      refunded_amount: refundedAmount,
      order: Array.isArray(patched) ? patched[0] : patched
    }, headers);
  } catch (error) {
    console.error("refund-order error", error);
    return response(500, { error: error.message || "Refund failed." }, headers);
  }
};

function getBearerToken(header) {
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Authentication token is missing.");
  return match[1];
}

async function verifyUser(token) {
  const result = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${token}`
    }
  });
  const body = await parseJson(result);
  if (!result.ok || !body.id) throw new Error("Your session is invalid or expired.");
  return body;
}

async function getProfile(userId) {
  const result = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${encodeURIComponent(userId)}&select=id,role,is_active`,
    { headers: adminHeaders() }
  );
  const body = await parseJson(result);
  if (!result.ok) throw new Error(body.message || "Unable to verify portal access.");
  return body[0] || null;
}

async function getOrder(orderId) {
  const select = [
    "id",
    "order_number",
    "store_order_number",
    "record_status",
    "payment_provider",
    "payment_status",
    "amount_paid",
    "payment_session_id",
    "payment_transaction_id"
  ].join(",");
  const result = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=${encodeURIComponent(select)}`,
    { headers: adminHeaders() }
  );
  const body = await parseJson(result);
  if (!result.ok) throw new Error(body.message || "Unable to load order payment information.");
  return body[0] || null;
}

async function stripeGet(path) {
  const result = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` }
  });
  const body = await parseJson(result);
  if (!result.ok) throw new Error(body?.error?.message || "Stripe lookup failed.");
  return body;
}

async function stripePost(path, params, idempotencyKey) {
  const result = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey
    },
    body: params.toString()
  });
  const body = await parseJson(result);
  if (!result.ok) throw new Error(body?.error?.message || "Stripe refund failed.");
  return body;
}

function adminHeaders() {
  return {
    "Content-Type": "application/json",
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
  };
}

async function parseJson(result) {
  return result.json().catch(() => ({}));
}

function response(statusCode, body, headers) {
  return { statusCode, headers, body: JSON.stringify(body) };
}
