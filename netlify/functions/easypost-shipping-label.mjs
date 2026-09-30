import { easypostApiKey, easypostEnvironment } from "./easypost-shipping-lib.mjs";

const HEADERS = { "Content-Type":"application/json", "Cache-Control":"no-store" };
const respond = (status, body) => new Response(JSON.stringify(body), { status, headers:HEADERS });
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

function bearer(request) {
  const match = String(request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Authentication token is missing.");
  return match[1];
}

async function parseJson(response) { return response.json().catch(() => ({})); }
function adminHeaders(extra = {}) {
  return { apikey:SUPABASE_SECRET_KEY, Authorization:`Bearer ${SUPABASE_SECRET_KEY}`, "Content-Type":"application/json", ...extra };
}

async function verifyPortalUser(token) {
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers:{ apikey:SUPABASE_SECRET_KEY, Authorization:`Bearer ${token}` } });
  const user = await parseJson(userResponse);
  if (!userResponse.ok || !user.id) throw new Error("Your session is invalid or expired.");

  const profileResponse = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role,is_active&limit=1`, { headers:adminHeaders() });
  const profiles = await parseJson(profileResponse);
  if (!profileResponse.ok) throw new Error(profiles?.message || "Unable to verify portal access.");
  const profile = profiles?.[0];
  if (!profile?.is_active || !["coffee_bean","barista"].includes(profile.role)) {
    const error = new Error("Barista or Coffee Bean access is required to buy shipping labels.");
    error.status = 403;
    throw error;
  }
  return user;
}

async function getOrder(orderId) {
  const select = [
    "id","order_number","record_status","fulfillment_method","shipping_status","shipping_carrier","shipping_tracking_number",
    "shipping_rate_source","shipping_rate_environment","shipping_easypost_rate_id","shipping_easypost_shipment_id"
  ].join(",");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=${encodeURIComponent(select)}&limit=1`, { headers:adminHeaders() });
  const rows = await parseJson(response);
  if (!response.ok) throw new Error(rows?.message || "Unable to load the shipping order.");
  return rows?.[0] || null;
}

function apiKeyForEnvironment(environment) {
  const env = String(environment || easypostEnvironment()).toLowerCase() === "production" ? "production" : "test";
  const key = env === "production" ? process.env.EASYPOST_PRODUCTION_API_KEY : process.env.EASYPOST_TEST_API_KEY;
  if (!key) throw new Error(`EasyPost ${env} API key is not configured.`);
  return { env, key };
}

async function easyPost(path, { method="GET", key, body } = {}) {
  const response = await fetch(`https://api.easypost.com/v2${path}`, {
    method,
    headers:{ Authorization:`Basic ${Buffer.from(`${key}:`).toString("base64")}`, Accept:"application/json", ...(body ? {"Content-Type":"application/json"} : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const result = await parseJson(response);
  if (!response.ok) {
    const message = result?.error?.message || result?.error?.errors?.[0]?.message || result?.message || "EasyPost label request failed.";
    const error = new Error(message);
    error.status = response.status;
    error.details = result;
    throw error;
  }
  return result;
}

function labelPayload(shipment, order) {
  const label = shipment?.postage_label || {};
  if (!label.label_url) return null;
  return {
    ok:true,
    order_id:order.id,
    order_number:order.order_number,
    environment:shipment.mode || order.shipping_rate_environment || easypostEnvironment(),
    shipment_id:shipment.id,
    carrier:shipment.selected_rate?.carrier || order.shipping_carrier || "USPS",
    service:shipment.selected_rate?.service || "GroundAdvantage",
    tracking_code:shipment.tracking_code || order.shipping_tracking_number || null,
    label_url:label.label_url,
    label_pdf_url:label.label_pdf_url || null,
    label_size:label.label_size || null,
    label_file_type:label.label_file_type || null,
    purchased:true
  };
}

async function embedLabelImage(payload) {
  if (!payload?.label_url) return payload;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(payload.label_url, { signal:controller.signal, redirect:"follow" });
    if (!response.ok) throw new Error(`Carrier label image returned HTTP ${response.status}.`);
    const contentType = String(response.headers.get("content-type") || "image/png").split(";")[0].trim();
    if (!contentType.startsWith("image/")) {
      throw new Error(`Carrier label is ${contentType || "not an image"}; an image label is required for framed printing.`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("Carrier label image was empty.");
    if (bytes.length > 5 * 1024 * 1024) throw new Error("Carrier label image was unexpectedly large.");
    return { ...payload, label_data_url:`data:${contentType};base64,${bytes.toString("base64")}` };
  } catch (error) {
    console.error("EasyPost carrier label could not be embedded:", error);
    const wrapped = new Error(`EasyPost returned a label, but the carrier-label image could not be loaded for printing: ${error?.message || "unknown error"}`);
    wrapped.status = 502;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

async function saveTracking(order, shipment, userId) {
  const tracking = shipment.tracking_code || order.shipping_tracking_number || null;
  const carrier = shipment.selected_rate?.carrier || order.shipping_carrier || "USPS";
  if (!tracking) return;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(order.id)}`, {
    method:"PATCH",
    headers:adminHeaders({ Prefer:"return=minimal" }),
    body:JSON.stringify({ shipping_tracking_number:tracking, shipping_carrier:carrier, updated_by:userId || null })
  });
  if (!response.ok) console.error("EasyPost label purchased but tracking could not be saved", await response.text());
}

export default async request => {
  if (request.method !== "POST") return respond(405, { error:"POST required." });
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return respond(500, { error:"Shipping-label configuration is unavailable." });

  try {
    const user = await verifyPortalUser(bearer(request));
    const input = await request.json().catch(() => ({}));
    const orderId = String(input.order_id || "").trim();
    if (!orderId) return respond(400, { error:"Order ID is required." });

    const order = await getOrder(orderId);
    if (!order) return respond(404, { error:"Order was not found." });
    if (order.record_status !== "active" || order.fulfillment_method !== "shipping") return respond(400, { error:"Only active shipping orders can have an EasyPost label." });
    if (order.shipping_rate_source !== "easypost" || !order.shipping_easypost_shipment_id || !order.shipping_easypost_rate_id) {
      return respond(409, { error:"This order does not have a saved EasyPost shipment and rate. It cannot automatically buy a carrier label." });
    }

    const { env, key } = apiKeyForEnvironment(order.shipping_rate_environment);
    let shipment = await easyPost(`/shipments/${encodeURIComponent(order.shipping_easypost_shipment_id)}`, { key });
    let payload = labelPayload(shipment, order);
    if (payload) {
      await saveTracking(order, shipment, user.id);
      payload = await embedLabelImage(payload);
      return respond(200, { ...payload, already_purchased:true });
    }

    if (input.confirm_purchase !== true) {
      return respond(409, { error:`Confirmation is required before purchasing ${env === "production" ? "real" : "test"} postage.`, requires_confirmation:true, environment:env });
    }

    shipment = await easyPost(`/shipments/${encodeURIComponent(order.shipping_easypost_shipment_id)}/buy`, {
      method:"POST",
      key,
      body:{ rate:{ id:order.shipping_easypost_rate_id } }
    });
    payload = labelPayload(shipment, order);
    if (!payload) throw new Error("EasyPost purchased postage but did not return a printable label.");
    await saveTracking(order, shipment, user.id);
    payload = await embedLabelImage(payload);
    return respond(200, { ...payload, already_purchased:false });
  } catch (error) {
    console.error("easypost-shipping-label failed:", error?.details || error);
    return respond(error.status || 500, { error:error.message || "EasyPost shipping label failed." });
  }
};
