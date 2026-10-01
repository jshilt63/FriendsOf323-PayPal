import tls from "node:tls";
import { createPaypalCheckout, paymentEnvironment, uuid } from "../lib/paypal.mjs";
import {
  easypostEnabled,
  easypostEnvironment,
  getEasyPostGroundAdvantageRate,
  packageIsRateReady,
  packageParcel,
  parseBagWeightOunces,
  storefrontOriginAddress
} from "./easypost-shipping-lib.mjs";

const PROCESSING_SUPPORT_RATE = 0.0349;
const PROCESSING_SUPPORT_FIXED = 0.49;

function calculateProcessingSupport(subtotal) {
  const amount = Number(subtotal || 0);
  if (amount <= 0) return 0;

  const raw = ((amount * PROCESSING_SUPPORT_RATE) + PROCESSING_SUPPORT_FIXED)
    / (1 - PROCESSING_SUPPORT_RATE);

  return Math.ceil((raw - Number.EPSILON) * 100) / 100;
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function nonEmptyText(value, maxLength = 500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getOrigin(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

async function loadShippingSettings({ supabaseUrl, serviceRoleKey }) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/storefront_settings?select=shipping_enabled,shipping_packaging_charge,shipping_return_name,shipping_return_address_line_1,shipping_return_address_line_2,shipping_return_city,shipping_return_state,shipping_return_postal_code&id=eq.1&limit=1`,
    { headers:{ apikey:serviceRoleKey, Authorization:`Bearer ${serviceRoleKey}`, Accept:"application/json" } }
  );
  if (!response.ok) throw new Error("Shipping settings could not be loaded.");
  const rows = await response.json();
  return rows?.[0] || {};
}

async function findShippingRate({ supabaseUrl, serviceRoleKey, bagCount }) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/shipping_rate_tiers?select=id,label,min_bags,max_bags,rate_amount,package_length_inches,package_width_inches,package_height_inches,package_weight_ounces&is_active=eq.true&min_bags=lte.${encodeURIComponent(bagCount)}&order=min_bags.desc`,
    { headers:{ apikey:serviceRoleKey, Authorization:`Bearer ${serviceRoleKey}`, Accept:"application/json" } }
  );
  if (!response.ok) throw new Error("Shipping rates could not be loaded.");
  const rates = await response.json();
  return rates.find(rate => rate.max_bags == null || bagCount <= Number(rate.max_bags)) || null;
}


function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : "$0.00";
}

function encodeHeader(value) {
  const text = String(value ?? "");
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function smtpCommand(socket, command, acceptedCodes) {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };

    const onError = error => {
      cleanup();
      reject(error);
    };

    const onTimeout = () => {
      cleanup();
      reject(new Error("Gmail SMTP connection timed out."));
    };

    const onData = chunk => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      if (!lines.length) return;

      const last = lines[lines.length - 1];
      if (!/^\d{3} /.test(last)) return;

      cleanup();
      const code = Number(last.slice(0, 3));

      if (!acceptedCodes.includes(code)) {
        reject(new Error(`Gmail SMTP rejected command (${code}): ${last}`));
        return;
      }

      resolve(buffer);
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("timeout", onTimeout);

    if (command !== null) socket.write(`${command}\r\n`);
  });
}

async function sendGmailSmtp({ user, appPassword, to, subject, text, html }) {
  const socket = tls.connect({
    host: "smtp.gmail.com",
    port: 465,
    servername: "smtp.gmail.com",
    rejectUnauthorized: true
  });

  socket.setTimeout(20000);

  await smtpCommand(socket, null, [220]);
  await smtpCommand(socket, "EHLO friendsof323storefront.netlify.app", [250]);
  await smtpCommand(socket, "AUTH LOGIN", [334]);
  await smtpCommand(socket, Buffer.from(user, "utf8").toString("base64"), [334]);
  await smtpCommand(
    socket,
    Buffer.from(appPassword.replace(/\s+/g, ""), "utf8").toString("base64"),
    [235]
  );
  await smtpCommand(socket, `MAIL FROM:<${user}>`, [250]);
  await smtpCommand(socket, `RCPT TO:<${to}>`, [250, 251]);
  await smtpCommand(socket, "DATA", [354]);

  const boundary = `f323_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const message = [
    `From: ${encodeHeader("Friends of 323 Coffee")} <${user}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    text,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "",
    html,
    "",
    `--${boundary}--`,
    ""
  ].join("\r\n").replace(/^\./gm, "..");

  await smtpCommand(socket, `${message}\r\n.`, [250]);
  await smtpCommand(socket, "QUIT", [221]);
  socket.end();
}

async function supabaseRpc({ supabaseUrl, serviceRoleKey, name, body = {} }) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body)
  });

  const bodyText = await response.text();
  let result = null;
  try { result = bodyText ? JSON.parse(bodyText) : null; } catch {}

  if (!response.ok) {
    throw new Error(`${name} failed (${response.status}): ${bodyText}`);
  }

  return result;
}

async function deliveryAlreadySent({
  supabaseUrl,
  serviceRoleKey,
  orderId,
  email,
  notificationType
}) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/order_notification_deliveries` +
      `?select=id&order_id=eq.${encodeURIComponent(orderId)}` +
      `&recipient_email=eq.${encodeURIComponent(email.toLowerCase())}` +
      `&notification_type=eq.${encodeURIComponent(notificationType)}` +
      `&sent_at=not.is.null&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: "application/json"
      }
    }
  );

  if (!response.ok) throw new Error(await response.text());
  return (await response.json()).length > 0;
}

async function recordDelivery({
  supabaseUrl,
  serviceRoleKey,
  orderId,
  recipientUserId = null,
  email,
  notificationType,
  sentAt = null,
  error = null
}) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/order_notification_deliveries`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        order_id: orderId,
        recipient_user_id: recipientUserId,
        recipient_email: email.toLowerCase(),
        notification_type: notificationType,
        sent_at: sentAt,
        last_attempt_at: new Date().toISOString(),
        last_error: error ? String(error).slice(0, 1500) : null
      })
    }
  );

  if (!response.ok) {
    console.error("Unable to record email delivery:", await response.text());
  }
}

function buildCashInternalEmail(payload) {
  const order = payload.order || {};
  const customer = payload.customer || {};
  const items = payload.items || [];
  const reference = order.store_order_number || `#${order.order_number}`;
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(" ");

  const itemLines = items.map(item => {
    const scout = item.is_general_fund
      ? "Pack 323 General Fund"
      : [item.scout_first_name, item.scout_last_name].filter(Boolean).join(" ");
    return `${item.product_name} — ${item.bag_size} — ${item.grind_label} — Qty ${item.quantity} — ${scout}`;
  });

  return {
    subject: `New CASH Friends of 323 Order ${reference}`,
    text: [
      `New Friends of 323 cash order ${reference}`,
      "",
      `Customer: ${customerName}`,
      customer.email ? `Email: ${customer.email}` : "",
      customer.phone ? `Phone: ${customer.phone}` : "",
      "",
      ...itemLines,
      "",
      `Coffee total: ${money(order.order_total || order.amount_due)}`,
      "",
      "PAYMENT STATUS: Awaiting cash payment",
      "Customer was instructed to pay the Scout's parent or Den Leader."
    ].filter(Boolean).join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:700px;color:#222;">
        <h2 style="color:#0e3a2f;">New Friends of 323 Cash Order</h2>
        <p style="font-size:18px;"><strong>${escapeHtml(reference)}</strong></p>
        <p>
          <strong>Customer:</strong> ${escapeHtml(customerName)}<br>
          ${customer.email ? `<strong>Email:</strong> ${escapeHtml(customer.email)}<br>` : ""}
          ${customer.phone ? `<strong>Phone:</strong> ${escapeHtml(customer.phone)}` : ""}
        </p>
        <ul>
          ${items.map(item => {
            const scout = item.is_general_fund
              ? "Pack 323 General Fund"
              : [item.scout_first_name, item.scout_last_name].filter(Boolean).join(" ");
            return `<li><strong>${escapeHtml(item.product_name)}</strong> — ${escapeHtml(item.bag_size)} — ${escapeHtml(item.grind_label)} — Qty ${escapeHtml(item.quantity)}<br>Credit: ${escapeHtml(scout)}</li>`;
          }).join("")}
        </ul>
        <p style="padding:12px;background:#fbf4df;border-radius:8px;">
          <strong>Payment Status:</strong> Awaiting cash payment<br>
          Customer was instructed to pay the Scout's parent or Den Leader.
        </p>
      </div>`
  };
}

function buildCashCustomerEmail(payload) {
  const order = payload.order || {};
  const customer = payload.customer || {};
  const items = payload.items || [];
  const reference = order.store_order_number || `#${order.order_number}`;
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(" ") || "Coffee Customer";

  return {
    subject: `Friends of 323 Order ${reference} — Cash Payment Due`,
    text: [
      `Friends of 323`,
      `Premium coffee. Purposeful impact.`,
      "",
      `Thank you, ${customerName}!`,
      `We received your coffee order ${reference}.`,
      "",
      ...items.map(item => `${item.product_name} — ${item.bag_size} — ${item.grind_label} — Qty ${item.quantity}`),
      "",
      `Amount due: ${money(order.order_total || order.amount_due)}`,
      "",
      "Please give your cash payment to the Scout's parent or your Den Leader.",
      "Your order will remain awaiting payment until the cash is received.",
      "",
      "Thank you for supporting Pack 323."
    ].join("\n"),
    html: `
<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f6f1e7;font-family:Arial,Helvetica,sans-serif;color:#2f302c;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f1e7;">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
       style="max-width:680px;background:#fff;border:1px solid #ded5c5;border-radius:12px;overflow:hidden;">
<tr><td style="background:#0e3a2f;padding:26px 28px;text-align:center;">
  <div style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#e5a93c;font-weight:700;">Community Fundraising Store</div>
  <div style="margin-top:7px;font-family:Georgia,'Times New Roman',serif;font-size:29px;letter-spacing:.06em;color:#fff;font-weight:700;">▲ FRIENDS OF 323 ▲</div>
  <div style="margin-top:6px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#f4efe5;">Premium coffee. Purposeful impact.</div>
</td></tr>
<tr><td style="padding:30px;text-align:center;">
  <div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#b57400;font-weight:700;">Order Received</div>
  <h1 style="margin:8px 0;font-family:Georgia,'Times New Roman',serif;font-size:28px;color:#0e3a2f;">Cash Payment Due</h1>
  <p style="margin:0;color:#57564f;line-height:1.6;">Thank you, ${escapeHtml(customerName)}. Your coffee order has been saved.</p>
</td></tr>
<tr><td style="padding:0 30px 18px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#fbf8f1;border:1px solid #e4dac8;border-radius:8px;">
    <tr>
      <td style="padding:14px 16px;"><div style="font-size:11px;text-transform:uppercase;color:#8a5a00;font-weight:700;">Order Number</div><div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#0e3a2f;">${escapeHtml(reference)}</div></td>
      <td style="padding:14px 16px;text-align:right;"><div style="font-size:11px;text-transform:uppercase;color:#8a5a00;font-weight:700;">Amount Due</div><div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#0e3a2f;">${escapeHtml(money(order.order_total || order.amount_due))}</div></td>
    </tr>
  </table>
</td></tr>
<tr><td style="padding:0 30px 20px;">
  <ul style="padding-left:20px;line-height:1.7;">
    ${items.map(item => `<li><strong>${escapeHtml(item.product_name)}</strong> — ${escapeHtml(item.bag_size)} — ${escapeHtml(item.grind_label)} — Qty ${escapeHtml(item.quantity)}</li>`).join("")}
  </ul>
</td></tr>
<tr><td style="padding:0 30px 30px;">
  <div style="background:#fbf4df;border-left:4px solid #e5a93c;padding:14px 16px;border-radius:6px;line-height:1.55;">
    <strong style="color:#0e3a2f;">Payment instructions</strong><br>
    Please give your cash payment to the Scout's parent or your Den Leader.
    Your order will remain marked as awaiting payment until the cash is received.
  </div>
</td></tr>
<tr><td style="background:#f4efe5;border-top:1px solid #ded5c5;padding:20px;text-align:center;">
  <strong style="color:#0e3a2f;">Friends of Pack 323</strong><br>
  <span style="font-size:12px;color:#746d62;">Premium coffee. Purposeful impact.</span>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
  };
}

async function sendCashOrderEmails({
  supabaseUrl,
  serviceRoleKey,
  gmailUser,
  gmailAppPassword,
  orderId
}) {
  const payload = await supabaseRpc({
    supabaseUrl,
    serviceRoleKey,
    name: "get_order_notification_payload",
    body: { p_order_id: orderId }
  });

  const recipients = await supabaseRpc({
    supabaseUrl,
    serviceRoleKey,
    name: "get_order_notification_recipients"
  });

  const failures = [];

  for (const recipient of Array.isArray(recipients) ? recipients : []) {
    const email = String(recipient.email || "").trim().toLowerCase();
    if (!email) continue;

    if (await deliveryAlreadySent({
      supabaseUrl, serviceRoleKey, orderId, email, notificationType: "internal"
    })) continue;

    try {
      const message = buildCashInternalEmail(payload);
      await sendGmailSmtp({
        user: gmailUser, appPassword: gmailAppPassword, to: email, ...message
      });
      await recordDelivery({
        supabaseUrl,
        serviceRoleKey,
        orderId,
        recipientUserId: recipient.user_id || null,
        email,
        notificationType: "internal",
        sentAt: new Date().toISOString()
      });
    } catch (error) {
      failures.push(error);
      await recordDelivery({
        supabaseUrl, serviceRoleKey, orderId,
        recipientUserId: recipient.user_id || null,
        email, notificationType: "internal",
        error: error.message || error
      });
    }
  }

  const customerEmail = String(payload?.customer?.email || "").trim().toLowerCase();

  if (customerEmail && !(await deliveryAlreadySent({
    supabaseUrl,
    serviceRoleKey,
    orderId,
    email: customerEmail,
    notificationType: "customer_confirmation"
  }))) {
    try {
      const message = buildCashCustomerEmail(payload);
      await sendGmailSmtp({
        user: gmailUser,
        appPassword: gmailAppPassword,
        to: customerEmail,
        ...message
      });
      await recordDelivery({
        supabaseUrl,
        serviceRoleKey,
        orderId,
        email: customerEmail,
        notificationType: "customer_confirmation",
        sentAt: new Date().toISOString()
      });
    } catch (error) {
      failures.push(error);
      await recordDelivery({
        supabaseUrl,
        serviceRoleKey,
        orderId,
        email: customerEmail,
        notificationType: "customer_confirmation",
        error: error.message || error
      });
    }
  }

  if (failures.length) {
    throw new Error(`${failures.length} cash-order notification email(s) failed.`);
  }
}


export default async (request) => {
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: "Store order configuration is missing." });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body." });
  }

  const customerInput = payload?.customer ?? {};
  const itemsInput = Array.isArray(payload?.items) ? payload.items : [];
  const requestedProcessingCost = Number(payload?.processing_cost ?? 0);
  const paymentMethod = payload?.payment_method === "cash" ? "cash" : "online";

  if (paymentMethod === "online") {
    try { paymentEnvironment(); }
    catch (error) { return jsonResponse(503, { error: error.message }); }
  }
  const fulfillmentMethod = nonEmptyText(payload?.fulfillment_method, 30);
  const allowedFulfillmentMethods = new Set(["pickup", "local_delivery", "shipping"]);

  if (!allowedFulfillmentMethods.has(fulfillmentMethod)) {
    return jsonResponse(400, { error: "Choose pickup, local delivery, or shipping before placing the order." });
  }

  const customer = {
    first_name: nonEmptyText(customerInput.first_name, 100),
    last_name: nonEmptyText(customerInput.last_name, 100),
    email: nonEmptyText(customerInput.email, 254).toLowerCase(),
    phone: nonEmptyText(customerInput.phone, 50),
    address_line_1: nonEmptyText(customerInput.address_line_1, 200),
    address_line_2: nonEmptyText(customerInput.address_line_2, 200),
    city: nonEmptyText(customerInput.city, 120),
    state: nonEmptyText(customerInput.state, 20).toUpperCase(),
    postal_code: nonEmptyText(customerInput.postal_code, 20)
  };

  if (
    !customer.first_name ||
    !customer.last_name ||
    !validEmail(customer.email) ||
    !customer.address_line_1 ||
    !customer.city ||
    !customer.state ||
    !customer.postal_code
  ) {
    return jsonResponse(400, { error: "Required customer information is missing or invalid." });
  }

  if (!Number.isFinite(requestedProcessingCost) || requestedProcessingCost < 0 || requestedProcessingCost > 100) {
    return jsonResponse(400, { error: "Processing cost is invalid." });
  }

  if (!itemsInput.length || itemsInput.length > 50) {
    return jsonResponse(400, { error: "At least one valid coffee item is required." });
  }

  const items = [];
  const productIds = new Set();

  for (const item of itemsInput) {
    const quantity = Number(item?.quantity);
    const grind = item?.grind;
    const allocationsInput = Array.isArray(item?.allocations) ? item.allocations : [];

    if (
      !uuid(item?.product_id) ||
      !item.product_id ||
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      quantity > 100 ||
      !["whole_bean", "ground"].includes(grind) ||
      !allocationsInput.length
    ) {
      return jsonResponse(400, { error: "One or more coffee items are invalid." });
    }

    let allocatedTotal = 0;
    const allocations = [];

    for (const allocation of allocationsInput) {
      const allocationQuantity = Number(allocation?.quantity);

      if (
        !uuid(allocation?.scout_id) ||
        !allocation.scout_id ||
        !Number.isInteger(allocationQuantity) ||
        allocationQuantity <= 0 ||
        allocationQuantity > quantity
      ) {
        return jsonResponse(400, { error: "One or more Scout allocations are invalid." });
      }

      allocatedTotal += allocationQuantity;
      allocations.push({
        scout_id: allocation.scout_id,
        quantity: allocationQuantity
      });
    }

    if (allocatedTotal !== quantity) {
      return jsonResponse(400, { error: "Scout allocations must equal the coffee quantity." });
    }

    productIds.add(item.product_id);
    items.push({
      product_id: item.product_id,
      grind,
      quantity,
      allocations
    });
  }

  // Fetch authoritative product names/prices from Supabase for payment validation.
  const encodedIds = Array.from(productIds).map(id => `"${id}"`).join(",");
  const productsResponse = await fetch(
    `${supabaseUrl}/rest/v1/products?select=id,product_name,bag_size,sale_price,is_active&id=in.(${encodeURIComponent(encodedIds)})`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      }
    }
  );

  if (!productsResponse.ok) {
    console.error("Product lookup failed:", await productsResponse.text());
    return jsonResponse(500, { error: "Unable to validate coffee products." });
  }

  const products = await productsResponse.json();
  const productMap = new Map(products.map(product => [product.id, product]));

  for (const item of items) {
    const product = productMap.get(item.product_id);
    if (!product || !product.is_active) {
      return jsonResponse(400, { error: "One or more selected coffee products are unavailable." });
    }
  }

  const scoutIds = [...new Set(items.flatMap(item => item.allocations.map(allocation => allocation.scout_id)))];
  const scoutResponse = await fetch(`${supabaseUrl}/rest/v1/scouts?select=id,is_active&id=in.(${scoutIds.join(",")})`, {headers:{apikey:serviceRoleKey,Authorization:`Bearer ${serviceRoleKey}`}});
  if (!scoutResponse.ok) return jsonResponse(500,{error:"Unable to validate Scout allocations."});
  const activeScouts = new Set((await scoutResponse.json()).filter(scout=>scout.is_active).map(scout=>scout.id));
  if (scoutIds.some(id=>!activeScouts.has(id))) return jsonResponse(400,{error:"One or more selected Scouts are unavailable."});

  const coffeeSubtotal = items.reduce((sum, item) => {
    const product = productMap.get(item.product_id);
    return sum + (Number(product.sale_price) * Number(item.quantity));
  }, 0);

  const shippingBagCount = items.reduce((sum, item) => sum + Number(item.quantity), 0);
  let shippingRate = null;
  let shippingAmount = 0;
  let shippingQuote = null;
  let shippingSettings = null;
  if (fulfillmentMethod === "shipping") {
    if (paymentMethod !== "online") {
      return jsonResponse(400, { error:"Shipped orders must be paid online so the shipping charge is included in the PayPal payment." });
    }
    try {
      shippingSettings = await loadShippingSettings({ supabaseUrl, serviceRoleKey });
      if (!shippingSettings.shipping_enabled) {
        return jsonResponse(400, { error:"Shipping is currently unavailable. Please choose pickup or local delivery." });
      }
      shippingRate = await findShippingRate({ supabaseUrl, serviceRoleKey, bagCount:shippingBagCount });
    } catch (error) {
      console.error("Shipping configuration lookup failed:", error);
      return jsonResponse(500, { error:"Shipping is temporarily unavailable." });
    }
    if (!shippingRate) {
      return jsonResponse(400, { error:`Shipping is not configured for ${shippingBagCount} bag${shippingBagCount === 1 ? "" : "s"}.` });
    }

    if (!easypostEnabled()) {
      return jsonResponse(503, { error:"EasyPost shipping rating is disabled. Shipping cannot be checked out until EasyPost is enabled." });
    }
    if (!packageIsRateReady(shippingRate)) {
      return jsonResponse(503, { error:`Shipping cannot be calculated for ${shippingRate.label || "this package"} because its dimensions or empty-box weight are incomplete.` });
    }

    {
      try {
        let contentsWeightOunces = 0;
        for (const item of items) {
          const product = productMap.get(item.product_id);
          const bagWeight = parseBagWeightOunces(product?.bag_size);
          if (!(bagWeight > 0)) throw new Error(`Shipping weight is not configured for ${product?.bag_size || "this bag size"}.`);
          contentsWeightOunces += bagWeight * Number(item.quantity);
        }
        const parcel = packageParcel(shippingRate, contentsWeightOunces);
        shippingQuote = await getEasyPostGroundAdvantageRate({
          fromAddress:storefrontOriginAddress(shippingSettings),
          toAddress:{
            name:[customer.first_name, customer.last_name].filter(Boolean).join(" "),
            street1:customer.address_line_1,
            street2:customer.address_line_2,
            city:customer.city,
            state:customer.state,
            zip:customer.postal_code,
            phone:customer.phone,
            email:customer.email
          },
          parcel
        });
        shippingQuote.parcel = parcel;
        const packagingCharge = Math.max(0, Number(shippingSettings.shipping_packaging_charge || 0));
        shippingQuote.packaging_charge = Number(packagingCharge.toFixed(2));
        shippingQuote.postage_amount = Number(shippingQuote.amount.toFixed(2));
        shippingQuote.customer_amount = Number((shippingQuote.postage_amount + shippingQuote.packaging_charge).toFixed(2));
        shippingAmount = shippingQuote.customer_amount;
      } catch (error) {
        console.error("EasyPost checkout rating failed:", error?.details || error);
        return jsonResponse(503, {
          error:`USPS shipping could not be calculated through EasyPost. ${error.message || "Please try again shortly."}`
        });
      }
    }
  }

  // Browser input controls only whether the customer opted in.
  // The amount itself is always recalculated server-side from
  // authoritative Supabase product pricing.
  const processingCost = paymentMethod === "cash"
    ? 0
    : requestedProcessingCost > 0
      ? calculateProcessingSupport(coffeeSubtotal)
      : 0;

  if (paymentMethod === "online") {
    try {
      // Sandbox checkout has its own records; it never calls the production order RPC.
      const result = await createPaypalCheckout({
        request, requestKey: payload.request_key,
        fingerprintPayload: payload,
        customer, items, coffeeSubtotal, processingCost, shippingAmount,
        fulfillment: {
        fulfillment_method: fulfillmentMethod,
        shipping_amount: shippingAmount,
        shipping_rate_id: shippingRate?.id || null,
        shipping_rate_label: fulfillmentMethod === "shipping"
          ? (shippingQuote?.source === "easypost" ? `USPS Ground Advantage — ${shippingRate?.label || "Package"}` : shippingRate?.label || null)
          : null,
        shipping_bag_count: fulfillmentMethod === "shipping" ? shippingBagCount : null,
        shipping_rate_source: fulfillmentMethod === "shipping" ? (shippingQuote?.source || "fallback") : null,
        shipping_carrier: shippingQuote?.source === "easypost" ? shippingQuote.carrier : null,
        shipping_service: shippingQuote?.source === "easypost" ? shippingQuote.service : null,
        shipping_rate_environment: fulfillmentMethod === "shipping" ? (shippingQuote?.environment || easypostEnvironment()) : null,
        shipping_rate_retail: shippingQuote?.source === "easypost" ? shippingQuote.retail_rate : null,
        shipping_rate_list: shippingQuote?.source === "easypost" ? shippingQuote.list_rate : null,
        shipping_rate_account: shippingQuote?.source === "easypost" ? shippingQuote.rate : null,
        shipping_postage_amount: shippingQuote?.source === "easypost" ? shippingQuote.postage_amount : null,
        shipping_packaging_charge: shippingQuote?.source === "easypost" ? shippingQuote.packaging_charge : null,
        shipping_package_weight_ounces: shippingQuote?.parcel?.weight ?? null,
        shipping_easypost_rate_id: shippingQuote?.source === "easypost" ? shippingQuote.rate_id : null,
        shipping_easypost_shipment_id: shippingQuote?.source === "easypost" ? shippingQuote.shipment_id : null
        }
      });
      return jsonResponse(201, result);
    } catch (error) {
      return jsonResponse(error.status || 500, { error: error.message || "PayPal checkout could not be created." });
    }
  }

  // Create the real unpaid Friends of 323 order first.
  const rpcResponse = await fetch(
    `${supabaseUrl}/rest/v1/rpc/create_storefront_order`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        p_customer: customer,
        p_items: items,
        p_processing_cost: processingCost
      })
    }
  );

  const rpcText = await rpcResponse.text();
  let order = {};
  try {
    order = rpcText ? JSON.parse(rpcText) : {};
  } catch {}

  if (!rpcResponse.ok) {
    console.error("create_storefront_order RPC failed:", {
      status: rpcResponse.status,
      details: rpcText
    });
    return jsonResponse(500, { error: "The Friends of 323 order could not be created." });
  }

  const fulfillmentUpdateResponse = await fetch(
    `${supabaseUrl}/rest/v1/orders?id=eq.${encodeURIComponent(order.order_id)}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        fulfillment_method: fulfillmentMethod,
        shipping_amount: shippingAmount,
        shipping_rate_id: shippingRate?.id || null,
        shipping_rate_label: fulfillmentMethod === "shipping"
          ? (shippingQuote?.source === "easypost" ? `USPS Ground Advantage — ${shippingRate?.label || "Package"}` : shippingRate?.label || null)
          : null,
        shipping_bag_count: fulfillmentMethod === "shipping" ? shippingBagCount : null,
        shipping_rate_source: fulfillmentMethod === "shipping" ? (shippingQuote?.source || "fallback") : null,
        shipping_carrier: shippingQuote?.source === "easypost" ? shippingQuote.carrier : null,
        shipping_service: shippingQuote?.source === "easypost" ? shippingQuote.service : null,
        shipping_rate_environment: fulfillmentMethod === "shipping" ? (shippingQuote?.environment || easypostEnvironment()) : null,
        shipping_rate_retail: shippingQuote?.source === "easypost" ? shippingQuote.retail_rate : null,
        shipping_rate_list: shippingQuote?.source === "easypost" ? shippingQuote.list_rate : null,
        shipping_rate_account: shippingQuote?.source === "easypost" ? shippingQuote.rate : null,
        shipping_postage_amount: shippingQuote?.source === "easypost" ? shippingQuote.postage_amount : null,
        shipping_packaging_charge: shippingQuote?.source === "easypost" ? shippingQuote.packaging_charge : null,
        shipping_package_weight_ounces: shippingQuote?.parcel?.weight ?? null,
        shipping_easypost_rate_id: shippingQuote?.source === "easypost" ? shippingQuote.rate_id : null,
        shipping_easypost_shipment_id: shippingQuote?.source === "easypost" ? shippingQuote.shipment_id : null
      })
    }
  );

  if (!fulfillmentUpdateResponse.ok) {
    console.error("Unable to save fulfillment method:", {
      details: await fulfillmentUpdateResponse.text(),
      order_id: order.order_id,
      fulfillment_method: fulfillmentMethod,
      shipping_amount: shippingAmount
    });
    return jsonResponse(500, {
      error: `Order ${order.store_order_number} was created, but its pickup/delivery choice could not be saved.`
    });
  }

  if (paymentMethod === "cash") {
    if (!gmailUser || !gmailAppPassword) {
      return jsonResponse(500, { error: "Cash-order email configuration is missing." });
    }

    const cashUpdateResponse = await fetch(
      `${supabaseUrl}/rest/v1/orders?id=eq.${encodeURIComponent(order.order_id)}`,
      {
        method: "PATCH",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          payment_method: "cash",
          payment_provider: "cash",
          payment_session_id: null,
          payment_transaction_id: null,
          payment_status: "unpaid",
          amount_paid: 0,
          wholesaler_status: "not_ready"
        })
      }
    );

    if (!cashUpdateResponse.ok) {
      console.error("Unable to configure cash order:", {
        details: await cashUpdateResponse.text(),
        order_id: order.order_id
      });

      return jsonResponse(500, {
        error: `Order ${order.store_order_number} was created, but its cash-payment status could not be saved.`
      });
    }

    try {
      await sendCashOrderEmails({
        supabaseUrl,
        serviceRoleKey,
        gmailUser,
        gmailAppPassword,
        orderId: order.order_id
      });
    } catch (error) {
      console.error("Cash order email notification failed:", {
        order_id: order.order_id,
        error: error?.message || String(error)
      });

      return jsonResponse(500, {
        error: `Order ${order.store_order_number} was created, but its confirmation email could not be sent. Please contact Friends of 323 before trying again.`
      });
    }

    return jsonResponse(201, {
      order_id: order.order_id,
      order_number: order.order_number,
      store_order_number: order.store_order_number,
      payment_method: "cash",
      payment_status: "unpaid",
      fulfillment_method: fulfillmentMethod,
      shipping_amount: shippingAmount
    });
  }

};
