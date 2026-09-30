import {
  createHmac,
  timingSafeEqual
} from "node:crypto";
import tls from "node:tls";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

const SIGNATURE_TOLERANCE_SECONDS = 300;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS
  });
}

function parseStripeSignature(header) {
  const parts = String(header || "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);

  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;

    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);

    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }

  return { timestamp, signatures };
}

function secureHexEqual(left, right) {
  try {
    const leftBuffer = Buffer.from(left, "hex");
    const rightBuffer = Buffer.from(right, "hex");

    if (leftBuffer.length !== rightBuffer.length) return false;

    return timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

function verifyStripeSignature(rawBody, signatureHeader, webhookSecret) {
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);

  if (!timestamp || !signatures.length) return false;

  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - numericTimestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const signedPayload = `${timestamp}.${rawBody}`;

  const expected = createHmac("sha256", webhookSecret)
    .update(signedPayload, "utf8")
    .digest("hex");

  return signatures.some(signature => secureHexEqual(signature, expected));
}

function unixSecondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return new Date().toISOString();
  }

  return new Date(seconds * 1000).toISOString();
}

async function confirmPayment({
  supabaseUrl,
  serviceRoleKey,
  session,
  eventCreated
}) {
  const orderId = session?.metadata?.order_id;

  if (!orderId) {
    throw new Error("Stripe session is missing Friends of 323 order metadata.");
  }

  if (session.payment_status !== "paid") {
    return {
      processed: false,
      reason: `Stripe session payment_status is ${session.payment_status || "unknown"}.`
    };
  }

  const amountTotal = Number(session.amount_total);

  if (!Number.isInteger(amountTotal) || amountTotal < 0) {
    throw new Error("Stripe session amount_total is invalid.");
  }

  const amountPaid = amountTotal / 100;

  const response = await fetch(
    `${supabaseUrl}/rest/v1/rpc/confirm_storefront_stripe_payment`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        p_order_id: orderId,
        p_session_id: session.id,
        p_payment_intent_id:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : null,
        p_amount_paid: amountPaid,
        p_event_created_at: unixSecondsToIso(eventCreated)
      })
    }
  );

  const responseText = await response.text();

  let result = {};
  try {
    result = responseText ? JSON.parse(responseText) : {};
  } catch {}

  if (!response.ok) {
    console.error("confirm_storefront_stripe_payment RPC failed:", {
      status: response.status,
      details: responseText,
      order_id: orderId,
      stripe_session_id: session.id
    });

    throw new Error("Friends of 323 payment confirmation failed.");
  }

  return {
    processed: true,
    result
  };
}


function encodeHeader(value) {
  const text = String(value ?? "");
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
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

    if (command !== null) {
      socket.write(`${command}\r\n`);
    }
  });
}

async function sendGmailSmtp({
  user,
  appPassword,
  to,
  subject,
  text,
  html
}) {
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
  await smtpCommand(
    socket,
    Buffer.from(user, "utf8").toString("base64"),
    [334]
  );
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
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    "",
    `--${boundary}--`,
    ""
  ]
    .join("\r\n")
    .replace(/^\./gm, "..");

  await smtpCommand(socket, `${message}\r\n.`, [250]);
  await smtpCommand(socket, "QUIT", [221]);
  socket.end();
}

async function callSupabaseRpc({
  supabaseUrl,
  serviceRoleKey,
  functionName,
  body = {}
}) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/rpc/${functionName}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const responseText = await response.text();
  let result = null;

  try {
    result = responseText ? JSON.parse(responseText) : null;
  } catch {}

  if (!response.ok) {
    throw new Error(
      `${functionName} failed (${response.status}): ${responseText}`
    );
  }

  return result;
}

async function notificationAlreadySent({
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

  if (!response.ok) {
    throw new Error(
      `Unable to check notification delivery: ${await response.text()}`
    );
  }

  const rows = await response.json();
  return rows.length > 0;
}

async function recordNotificationSent({
  supabaseUrl,
  serviceRoleKey,
  orderId,
  recipient,
  notificationType
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
        recipient_user_id: recipient.user_id ?? null,
        recipient_email: recipient.email.toLowerCase(),
        notification_type: notificationType,
        sent_at: new Date().toISOString(),
        last_error: null
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Unable to record sent notification: ${await response.text()}`
    );
  }
}

async function recordNotificationFailure({
  supabaseUrl,
  serviceRoleKey,
  orderId,
  recipient,
  notificationType,
  error
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
        recipient_user_id: recipient.user_id ?? null,
        recipient_email: recipient.email.toLowerCase(),
        notification_type: notificationType,
        sent_at: null,
        last_attempt_at: new Date().toISOString(),
        last_error: String(error?.message || error).slice(0, 1500)
      })
    }
  );

  if (!response.ok) {
    console.error(
      "Unable to record notification failure:",
      await response.text()
    );
  }
}

function buildOrderNotification(payload) {
  const order = payload?.order ?? {};
  const customer = payload?.customer ?? {};
  const items = Array.isArray(payload?.items) ? payload.items : [];

  const reference =
    order.store_order_number ||
    order.ecwid_order_number ||
    `#${order.order_number}`;

  const subject = `New Friends of 323 Coffee Order ${reference}`;

  const customerName = [customer.first_name, customer.last_name]
    .filter(Boolean)
    .join(" ")
    .trim() || "Customer";

  const textItems = items.map(item => {
    const scoutName = [item.scout_first_name, item.scout_last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || "General Fund";

    return [
      `${item.product_name} — ${item.bag_size} — ${item.grind_label}`,
      `Qty ${item.quantity} — ${money(item.line_total)}`,
      `Scout/Fund: ${scoutName}`
    ].join("\n");
  });

  const processingLine = Number(order.processing_cost || 0) > 0
    ? `\nProcessing support: ${money(order.processing_cost)}`
    : "";

  const text = [
    `New paid Friends of 323 coffee order ${reference}`,
    "",
    `Internal order: #${order.order_number}`,
    `Customer: ${customerName}`,
    customer.email ? `Customer email: ${customer.email}` : "",
    customer.phone ? `Customer phone: ${customer.phone}` : "",
    "",
    "Order:",
    textItems.join("\n\n"),
    processingLine,
    `Total paid: ${money(order.amount_paid)}`,
    "",
    "Status: Paid / Ready to Order"
  ].filter(Boolean).join("\n");

  const htmlItems = items.map(item => {
    const scoutName = [item.scout_first_name, item.scout_last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || "General Fund";

    return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #ddd;">
          <strong>${escapeHtml(item.product_name)}</strong><br>
          ${escapeHtml(item.bag_size)} · ${escapeHtml(item.grind_label)}
        </td>
        <td style="padding:8px;border-bottom:1px solid #ddd;text-align:center;">
          ${escapeHtml(item.quantity)}
        </td>
        <td style="padding:8px;border-bottom:1px solid #ddd;">
          ${escapeHtml(scoutName)}
        </td>
        <td style="padding:8px;border-bottom:1px solid #ddd;text-align:right;">
          ${escapeHtml(money(item.line_total))}
        </td>
      </tr>`;
  }).join("");

  const html = `
<!doctype html>
<html>
  <body style="font-family:Arial,sans-serif;color:#222;line-height:1.45;">
    <div style="max-width:700px;margin:0 auto;">
      <h2 style="color:#0e3a2f;margin-bottom:4px;">
        New Friends of 323 Coffee Order
      </h2>
      <p style="margin-top:0;font-size:18px;">
        <strong>${escapeHtml(reference)}</strong>
      </p>

      <p>
        <strong>Internal order:</strong> #${escapeHtml(order.order_number)}<br>
        <strong>Customer:</strong> ${escapeHtml(customerName)}
        ${customer.email ? `<br><strong>Email:</strong> ${escapeHtml(customer.email)}` : ""}
        ${customer.phone ? `<br><strong>Phone:</strong> ${escapeHtml(customer.phone)}` : ""}
      </p>

      <table style="width:100%;border-collapse:collapse;margin:18px 0;">
        <thead>
          <tr style="background:#f4efe5;">
            <th style="padding:8px;text-align:left;">Coffee</th>
            <th style="padding:8px;text-align:center;">Qty</th>
            <th style="padding:8px;text-align:left;">Scout / Fund</th>
            <th style="padding:8px;text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>${htmlItems}</tbody>
      </table>

      ${Number(order.processing_cost || 0) > 0
        ? `<p><strong>Processing support:</strong> ${escapeHtml(money(order.processing_cost))}</p>`
        : ""}

      <p style="font-size:18px;">
        <strong>Total paid: ${escapeHtml(money(order.amount_paid))}</strong>
      </p>

      <p style="padding:10px;background:#eef5ec;border-radius:6px;">
        <strong>Status:</strong> Paid · Ready to Order
      </p>
    </div>
  </body>
</html>`;

  return { subject, text, html };
}


function buildCustomerConfirmation(payload) {
  const order = payload?.order ?? {};
  const customer = payload?.customer ?? {};
  const items = Array.isArray(payload?.items) ? payload.items : [];

  const reference =
    order.store_order_number ||
    order.ecwid_order_number ||
    `#${order.order_number}`;

  const customerName = [customer.first_name, customer.last_name]
    .filter(Boolean)
    .join(" ")
    .trim() || "Coffee Customer";

  const subject = `Friends of 323 Order ${reference} — Payment Received`;

  const textItems = items.map(item => {
    const scoutName = item.is_general_fund
      ? "Pack 323 General Fund"
      : [item.scout_first_name, item.scout_last_name]
          .filter(Boolean)
          .join(" ")
          .trim() || "Pack 323";

    return [
      item.product_name,
      `${item.bag_size} • ${item.grind_label} • Qty ${item.quantity}`,
      `Fundraising credit: ${scoutName}`,
      `${money(item.line_total)}`
    ].join("\n");
  });

  const text = [
    `Friends of 323`,
    `Premium coffee. Purposeful impact.`,
    "",
    `Thank you, ${customerName}!`,
    `We received your payment for order ${reference}.`,
    "",
    ...textItems.flatMap(item => [item, ""]),
    Number(order.processing_cost || 0) > 0
      ? `Processing support: ${money(order.processing_cost)}`
      : "",
    `Total paid: ${money(order.amount_paid)}`,
    "",
    "Your order is now in our coffee-ordering workflow.",
    "We will contact you when your coffee is ready for pickup or delivery.",
    "",
    "Thank you for supporting Pack 323."
  ].filter(Boolean).join("\n");

  const htmlItems = items.map(item => {
    const scoutName = item.is_general_fund
      ? "Pack 323 General Fund"
      : [item.scout_first_name, item.scout_last_name]
          .filter(Boolean)
          .join(" ")
          .trim() || "Pack 323";

    return `
      <tr>
        <td style="padding:14px 12px;border-bottom:1px solid #e7dfd0;">
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:16px;font-weight:700;color:#0e3a2f;">
            ${escapeHtml(item.product_name)}
          </div>
          <div style="margin-top:3px;font-size:13px;color:#5f5a50;">
            ${escapeHtml(item.bag_size)} &nbsp;•&nbsp; ${escapeHtml(item.grind_label)}
          </div>
          <div style="margin-top:7px;font-size:12px;color:#8a5a00;text-transform:uppercase;letter-spacing:.08em;font-weight:700;">
            Fundraising Credit
          </div>
          <div style="font-size:13px;color:#3b3a35;">
            ${escapeHtml(scoutName)}
          </div>
        </td>
        <td style="padding:14px 12px;border-bottom:1px solid #e7dfd0;text-align:center;font-size:14px;color:#3b3a35;">
          ${escapeHtml(item.quantity)}
        </td>
        <td style="padding:14px 12px;border-bottom:1px solid #e7dfd0;text-align:right;font-size:15px;font-weight:700;color:#0e3a2f;">
          ${escapeHtml(money(item.line_total))}
        </td>
      </tr>`;
  }).join("");

  const html = `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f1e7;font-family:Arial,Helvetica,sans-serif;color:#2f302c;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f1e7;">
      <tr>
        <td align="center" style="padding:28px 12px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
                 style="max-width:680px;background:#ffffff;border:1px solid #ded5c5;border-radius:12px;overflow:hidden;">

            <tr>
              <td style="background:#0e3a2f;padding:26px 28px;text-align:center;">
                <div style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#e5a93c;font-weight:700;">
                  Community Fundraising Store
                </div>
                <div style="margin-top:7px;font-family:Georgia,'Times New Roman',serif;font-size:29px;letter-spacing:.06em;color:#ffffff;font-weight:700;">
                  ▲ FRIENDS OF 323 ▲
                </div>
                <div style="margin-top:6px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#f4efe5;">
                  Premium coffee. Purposeful impact.
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:30px 30px 18px;text-align:center;">
                <div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#b57400;font-weight:700;">
                  Thank You For Your Order
                </div>
                <h1 style="margin:8px 0 8px;font-family:Georgia,'Times New Roman',serif;font-size:28px;color:#0e3a2f;">
                  Payment Received
                </h1>
                <p style="margin:0;font-size:15px;line-height:1.6;color:#57564f;">
                  Thank you, ${escapeHtml(customerName)}. We received your payment and your coffee order is now in our ordering workflow.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:0 30px 18px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
                       style="background:#fbf8f1;border:1px solid #e4dac8;border-radius:8px;">
                  <tr>
                    <td style="padding:14px 16px;">
                      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#8a5a00;font-weight:700;">Order Number</div>
                      <div style="margin-top:3px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:#0e3a2f;">
                        ${escapeHtml(reference)}
                      </div>
                    </td>
                    <td style="padding:14px 16px;text-align:right;">
                      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#8a5a00;font-weight:700;">Total Paid</div>
                      <div style="margin-top:3px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:#0e3a2f;">
                        ${escapeHtml(money(order.amount_paid))}
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0 30px 8px;">
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:19px;color:#0e3a2f;font-weight:700;margin-bottom:8px;">
                  Your Coffee
                </div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
                       style="border:1px solid #e4dac8;border-radius:8px;border-collapse:separate;border-spacing:0;">
                  <tr style="background:#f4efe5;">
                    <th style="padding:9px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5b554a;">Coffee</th>
                    <th style="padding:9px 12px;text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5b554a;">Qty</th>
                    <th style="padding:9px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5b554a;">Total</th>
                  </tr>
                  ${htmlItems}
                </table>
              </td>
            </tr>

            ${Number(order.processing_cost || 0) > 0 ? `
            <tr>
              <td style="padding:12px 30px 0;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
                       style="background:#fbf8f1;border-radius:7px;">
                  <tr>
                    <td style="padding:10px 12px;color:#5f5a50;font-size:13px;">
                      Processing Cost Support
                    </td>
                    <td style="padding:10px 12px;text-align:right;color:#0e3a2f;font-weight:700;font-size:13px;">
                      ${escapeHtml(money(order.processing_cost))}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>` : ""}

            <tr>
              <td style="padding:24px 30px 30px;">
                <div style="background:#eef3ed;border-left:4px solid #0e3a2f;padding:14px 16px;border-radius:6px;color:#3e443d;font-size:14px;line-height:1.55;">
                  <strong style="color:#0e3a2f;">What happens next?</strong><br>
                  Your order is now being prepared for the next roaster order. We will contact you when your coffee is ready for pickup or delivery.
                </div>
              </td>
            </tr>

            <tr>
              <td style="background:#f4efe5;border-top:1px solid #ded5c5;padding:20px 28px;text-align:center;">
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:15px;font-weight:700;color:#0e3a2f;">
                  Friends of Pack 323
                </div>
                <div style="margin-top:4px;font-size:12px;color:#746d62;">
                  Premium coffee. Purposeful impact.
                </div>
                <div style="margin-top:9px;font-size:11px;color:#8b8479;">
                  Thank you for supporting local youth.
                </div>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

async function sendCustomerConfirmation({
  supabaseUrl,
  serviceRoleKey,
  gmailUser,
  gmailAppPassword,
  orderId,
  payload
}) {
  const email = String(payload?.customer?.email || "").trim().toLowerCase();

  if (!email) {
    console.log("Customer confirmation skipped: order has no customer email.", {
      order_id: orderId
    });
    return { sent: 0, skipped: 1 };
  }

  const alreadySent = await notificationAlreadySent({
    supabaseUrl,
    serviceRoleKey,
    orderId,
    email,
    notificationType: "customer_confirmation"
  });

  if (alreadySent) {
    return { sent: 0, skipped: 1 };
  }

  const recipient = {
    user_id: null,
    email
  };

  try {
    const message = buildCustomerConfirmation(payload);

    await sendGmailSmtp({
      user: gmailUser,
      appPassword: gmailAppPassword,
      to: email,
      subject: message.subject,
      text: message.text,
      html: message.html
    });

    await recordNotificationSent({
      supabaseUrl,
      serviceRoleKey,
      orderId,
      recipient,
      notificationType: "customer_confirmation"
    });

    return { sent: 1, skipped: 0 };

  } catch (error) {
    await recordNotificationFailure({
      supabaseUrl,
      serviceRoleKey,
      orderId,
      recipient,
      notificationType: "customer_confirmation",
      error
    });

    throw error;
  }
}

async function sendOrderNotifications({
  supabaseUrl,
  serviceRoleKey,
  gmailUser,
  gmailAppPassword,
  orderId,
  payload: suppliedPayload = null
}) {
  const recipients = await callSupabaseRpc({
    supabaseUrl,
    serviceRoleKey,
    functionName: "get_order_notification_recipients"
  });

  if (!Array.isArray(recipients) || recipients.length === 0) {
    console.log("No active order-notification recipients are configured.");
    return { sent: 0, skipped: 0 };
  }

  const payload = suppliedPayload || await callSupabaseRpc({
    supabaseUrl,
    serviceRoleKey,
    functionName: "get_order_notification_payload",
    body: { p_order_id: orderId }
  });

  const message = buildOrderNotification(payload);

  let sent = 0;
  let skipped = 0;
  const failures = [];

  for (const recipient of recipients) {
    const email = String(recipient?.email || "").trim().toLowerCase();
    if (!email) continue;

    if (await notificationAlreadySent({
      supabaseUrl,
      serviceRoleKey,
      orderId,
      email,
      notificationType: "internal"
    })) {
      skipped += 1;
      continue;
    }

    try {
      await sendGmailSmtp({
        user: gmailUser,
        appPassword: gmailAppPassword,
        to: email,
        subject: message.subject,
        text: message.text,
        html: message.html
      });

      await recordNotificationSent({
        supabaseUrl,
        serviceRoleKey,
        orderId,
        recipient: { ...recipient, email },
        notificationType: "internal"
      });

      sent += 1;
    } catch (error) {
      failures.push({ email, error: String(error?.message || error) });

      await recordNotificationFailure({
        supabaseUrl,
        serviceRoleKey,
        orderId,
        recipient: { ...recipient, email },
        notificationType: "internal",
        error
      });
    }
  }

  if (failures.length) {
    console.error("One or more order notifications failed:", failures);
    throw new Error(
      `${failures.length} order notification email(s) failed.`
    );
  }

  return { sent, skipped };
}

export default async (request) => {
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

  if (!webhookSecret || !supabaseUrl || !serviceRoleKey) {
    console.error("Stripe webhook configuration is incomplete.");
    return jsonResponse(500, { error: "Webhook configuration is missing." });
  }

  // Stripe requires the exact raw request body for signature verification.
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("stripe-signature");

  if (!verifyStripeSignature(rawBody, signatureHeader, webhookSecret)) {
    console.error("Stripe webhook signature verification failed.");
    return jsonResponse(400, { error: "Invalid Stripe signature." });
  }

  let event;

  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: "Invalid Stripe event payload." });
  }

  try {
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      const session = event?.data?.object;

      const confirmation = await confirmPayment({
        supabaseUrl,
        serviceRoleKey,
        session,
        eventCreated: event.created
      });

      if (!confirmation.processed) {
        console.log("Stripe Checkout event received but not fulfilled yet:", {
          event_type: event.type,
          session_id: session?.id,
          payment_status: session?.payment_status,
          reason: confirmation.reason
        });
      } else {
        console.log("Friends of 323 Stripe payment confirmed:", {
          event_type: event.type,
          stripe_session_id: session?.id,
          store_order_number:
            confirmation.result?.store_order_number,
          order_number:
            confirmation.result?.order_number,
          already_processed:
            confirmation.result?.already_processed
        });

        const orderId = session?.metadata?.order_id;

        // Payment fulfillment must not depend on email configuration.
        // If Gmail is unavailable, keep the Stripe payment confirmed and
        // let the notification issue be repaired independently.
        if (!gmailUser || !gmailAppPassword) {
          console.error("Order email configuration is missing; payment was still confirmed.", {
            order_id: orderId
          });
        } else {
          const notificationPayload = await callSupabaseRpc({
            supabaseUrl,
            serviceRoleKey,
            functionName: "get_order_notification_payload",
            body: { p_order_id: orderId }
          });

          const notificationResult = await sendOrderNotifications({
            supabaseUrl,
            serviceRoleKey,
            gmailUser,
            gmailAppPassword,
            orderId,
            payload: notificationPayload
          });

          const customerResult = await sendCustomerConfirmation({
            supabaseUrl,
            serviceRoleKey,
            gmailUser,
            gmailAppPassword,
            orderId,
            payload: notificationPayload
          });

          console.log("Friends of 323 order emails complete:", {
            order_id: orderId,
            internal_sent: notificationResult.sent,
            internal_skipped: notificationResult.skipped,
            customer_sent: customerResult.sent,
            customer_skipped: customerResult.skipped
          });
        }
      }
    }

    if (["payout.paid", "payout.failed", "payout.canceled"].includes(event.type)) {
      const stripePayout = event?.data?.object;
      const status = event.type === "payout.paid"
        ? "paid"
        : event.type === "payout.failed"
          ? "failed"
          : "canceled";

      if (stripePayout?.id) {
        await callSupabaseRpc({
          supabaseUrl,
          serviceRoleKey,
          functionName: "update_credit_payout_from_stripe",
          body: {
            p_stripe_payout_id: stripePayout.id,
            p_status: status,
            p_failure_message: stripePayout.failure_message || null,
            p_arrival_date: stripePayout.arrival_date
              ? unixSecondsToIso(stripePayout.arrival_date).slice(0, 10)
              : null
          }
        });

        await callSupabaseRpc({
          supabaseUrl,
          serviceRoleKey,
          functionName: "update_roaster_funding_from_stripe",
          body: {
            p_stripe_id: stripePayout.id,
            p_status: status,
            p_failure: stripePayout.failure_message || null,
            p_arrival: stripePayout.arrival_date
              ? unixSecondsToIso(stripePayout.arrival_date).slice(0,10)
              : null
          }
        });

        console.log("Friends of 323 bank payout status updated:", {
          stripe_payout_id: stripePayout.id,
          status
        });
      }
    }

    // Return 200 for unhandled Stripe event types so Stripe doesn't retry them.
    return jsonResponse(200, { received: true });

  } catch (error) {
    console.error("Stripe webhook processing failed:", error);

    // Return 500 so Stripe retries a valid event that failed during fulfillment.
    return jsonResponse(500, {
      error: "Stripe event could not be processed."
    });
  }
};
