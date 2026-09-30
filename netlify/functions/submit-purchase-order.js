const tls = require("node:tls");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const BUCKET = "purchase-orders";

exports.handler = async function handler(event) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod !== "POST") return response(405, { error: "Method not allowed." }, headers);
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return response(500, { error: "Supabase server configuration is incomplete." }, headers);
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return response(500, { error: "Gmail configuration is incomplete in Netlify." }, headers);

  let poId = null;
  try {
    const token = getBearerToken(event.headers.authorization || event.headers.Authorization);
    const caller = await verifyUser(token);
    const profile = await getProfile(caller.id);
    if (!profile?.is_active || profile.role !== "coffee_bean") return response(403, { error: "Coffee Bean access is required." }, headers);

    const body = JSON.parse(event.body || "{}");
    poId = String(body.purchase_order_id || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(poId)) return response(400, { error: "A valid purchase-order ID is required." }, headers);

    const po = await getOne(`/rest/v1/purchase_orders?id=eq.${encodeURIComponent(poId)}&select=*`);
    if (!po) return response(404, { error: "Purchase order was not found." }, headers);
    if (po.status !== "draft") return response(409, { error: `${po.po_number} is no longer a draft purchase order.` }, headers);
    if (po.email_status === "processing") return response(409, { error: "This purchase order is already being submitted." }, headers);
    if (po.email_status === "sent") return response(409, { error: "The email was already sent. Check this purchase order before attempting to submit again." }, headers);
    const supplier = await getOne(`/rest/v1/purchase_order_supplier_settings?supplier_name=eq.${encodeURIComponent(po.supplier_name)}&select=po_email`);
    const recipient = String(supplier?.po_email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return response(400, { error: `Set a valid email for ${po.supplier_name} under Administration → Roaster before submitting.` }, headers);

    await patchPurchaseOrder(poId, {
      email_status: "processing",
      email_error: null,
      submission_email: recipient,
      updated_by: caller.id
    }, "draft");

    const [items, manualItems] = await Promise.all([
      restGet(`/rest/v1/purchase_order_item_summary?purchase_order_id=eq.${encodeURIComponent(poId)}&select=*`),
      restGet(`/rest/v1/purchase_order_manual_item_detail?purchase_order_id=eq.${encodeURIComponent(poId)}&select=*`)
    ]);
    const totalBags = sum(items, "quantity_ordered") + sum(manualItems, "quantity_ordered");
    if (totalBags <= 0) throw new Error("A purchase order must contain at least one bag before it can be submitted.");

    const pdf = buildPurchaseOrderPdf(po, items, manualItems);
    const year = String(po.order_date || new Date().getFullYear()).slice(0, 4);
    const supplierSlug = slug(po.supplier_name || "supplier");
    const storagePath = `${year}/${supplierSlug}/${safeFilename(po.po_number)}.pdf`;
    await uploadPdf(storagePath, pdf);

    await patchPurchaseOrder(poId, {
      pdf_storage_path: storagePath,
      pdf_generated_at: new Date().toISOString(),
      submission_email: recipient,
      updated_by: caller.id
    }, "draft");

    const subject = `${po.po_number} - Friends of 323 Coffee Purchase Order`;
    const text = `Hello,\n\nAttached is ${po.po_number} from Friends of 323 for ${totalBags} bag${totalBags === 1 ? "" : "s"}.\n\nThank you,\nFriends of 323`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#30291e"><h2>${escapeHtml(po.po_number)}</h2><p>Hello,</p><p>Attached is the Friends of 323 purchase order for <strong>${totalBags} bag${totalBags === 1 ? "" : "s"}</strong>.</p><p>Thank you,<br>Friends of 323</p></div>`;

    await sendGmailSmtp({
      user: GMAIL_USER,
      appPassword: GMAIL_APP_PASSWORD,
      to: recipient,
      subject,
      text,
      html,
      attachment: { filename: `${safeFilename(po.po_number)}.pdf`, contentType: "application/pdf", buffer: pdf }
    });

    const sentAt = new Date().toISOString();
    await patchPurchaseOrder(poId, {
      submission_email: recipient,
      email_status: "sent",
      email_sent_at: sentAt,
      email_error: null,
      submitted_by: caller.id,
      updated_by: caller.id
    }, "draft");

    // Use the existing workflow so related customer orders advance as well.
    const transition = await fetch(`${SUPABASE_URL}/rest/v1/rpc/transition_purchase_order`, {
      method: "POST",
      headers: { ...adminHeaders(), Authorization: `Bearer ${token}` },
      body: JSON.stringify({ p_purchase_order_id: poId, p_status: "submitted" })
    });
    if (!transition.ok) {
      const details = await parseJson(transition);
      throw new Error(`Email sent to ${recipient}, but status could not be updated: ${details.message || details.error || "database error"}. Do not email this order again.`);
    }

    return response(200, {
      success: true,
      purchase_order_id: poId,
      po_number: po.po_number,
      recipient_email: recipient,
      total_bags: totalBags,
      pdf_storage_path: storagePath,
      email_sent_at: sentAt
    }, headers);
  } catch (error) {
    console.error("submit-purchase-order error", error);
    if (poId && /^[0-9a-f-]{36}$/i.test(poId)) {
      try {
        const current = await getOne(`/rest/v1/purchase_orders?id=eq.${encodeURIComponent(poId)}&select=email_status`);
        if (current?.email_status !== "sent") await patchPurchaseOrder(poId, {
          email_status: "failed",
          email_error: String(error.message || "Submission failed.").slice(0, 1000)
        }, "draft");
      } catch (updateError) {
        console.error("Unable to record PO submission failure", updateError);
      }
    }
    return response(500, { error: error.message || "Purchase order submission failed." }, headers);
  }
};

async function verifyUser(token) {
  const result = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${token}` } });
  const body = await parseJson(result);
  if (!result.ok || !body.id) throw new Error("Your session is invalid or expired.");
  return body;
}
async function getProfile(userId) { return await getOne(`/rest/v1/user_profiles?id=eq.${encodeURIComponent(userId)}&select=id,role,is_active`); }
async function getOne(path) { const rows = await restGet(path); return rows[0] || null; }
async function restGet(path) {
  const result = await fetch(`${SUPABASE_URL}${path}`, { headers: adminHeaders() });
  const body = await parseJson(result);
  if (!result.ok) throw new Error(body.message || body.error || "Database lookup failed.");
  return body;
}
async function patchPurchaseOrder(id, payload, requiredStatus) {
  let path = `/rest/v1/purchase_orders?id=eq.${encodeURIComponent(id)}`;
  if (requiredStatus) path += `&status=eq.${encodeURIComponent(requiredStatus)}`;
  const result = await fetch(`${SUPABASE_URL}${path}`, {
    method: "PATCH",
    headers: { ...adminHeaders(), Prefer: "return=representation" },
    body: JSON.stringify(payload)
  });
  const body = await parseJson(result);
  if (!result.ok) throw new Error(body.message || body.error || "Purchase order could not be updated.");
  if (requiredStatus && (!Array.isArray(body) || body.length !== 1)) throw new Error("The purchase order changed while it was being submitted. Please reload it before trying again.");
  return body[0] || null;
}
async function uploadPdf(path, pdf) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const result = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encoded}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/pdf",
      "x-upsert": "true",
      "Cache-Control": "no-cache"
    },
    body: pdf
  });
  if (!result.ok) {
    const body = await result.text();
    throw new Error(`The purchase-order PDF could not be archived in Supabase Storage. ${body}`.trim());
  }
}
function adminHeaders() { return { "Content-Type": "application/json", apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` }; }
function getBearerToken(header) { const match = String(header || "").match(/^Bearer\s+(.+)$/i); if (!match) throw new Error("Authentication token is missing."); return match[1]; }
async function parseJson(result) { return result.json().catch(() => ({})); }
function response(statusCode, body, headers) { return { statusCode, headers, body: JSON.stringify(body) }; }
function sum(rows, key) { return rows.reduce((total, row) => total + Number(row[key] || 0), 0); }
function money(value) { const n = Number(value || 0); return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`; }
function labelGrind(value) { return value === "whole_bean" ? "Whole Bean" : "Ground"; }
function safeFilename(value) { return String(value || "purchase-order").replace(/[^a-z0-9._-]+/gi, "-"); }
function slug(value) { return String(value || "supplier").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "supplier"; }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

function buildPurchaseOrderPdf(po, normalItems, manualItems) {
  const rows = [
    ...normalItems.map(item => ({ ...item, manual: false, recipient_name: "", reason: "" })),
    ...manualItems.map(item => ({ ...item, manual: true }))
  ].sort((a, b) => String(a.sku || "").localeCompare(String(b.sku || ""), undefined, { numeric: true, sensitivity: "base" }) || String(a.grind || "").localeCompare(String(b.grind || "")));

  const totalBags = sum(rows, "quantity_ordered");
  const totalCost = rows.reduce((t, r) => t + Number(r.extended_cost || 0), 0);
  const lines = [];
  lines.push({ text: "FRIENDS OF 323 COFFEE FUNDRAISER", size: 15, bold: true, gap: 4 });
  lines.push({ text: "PURCHASE ORDER", size: 20, bold: true, gap: 8 });
  lines.push({ text: `${po.po_number}    Date: ${formatDate(po.order_date)}`, size: 10, bold: true });
  lines.push({ text: `Supplier: ${po.supplier_name}`, size: 10, gap: 10 });
  lines.push({ text: "SKU          SUPPLIER PRODUCT                    SIZE    GRIND       QTY     COST", size: 9, bold: true });
  lines.push({ text: "-------------------------------------------------------------------------------", size: 9 });
  for (const row of rows) {
    const sku = fit(row.sku, 12);
    const product = fit(`${row.supplier_product_name}${row.manual ? " [MANUAL]" : ""}`, 35);
    const size = fit(row.bag_size, 7);
    const grind = fit(labelGrind(row.grind), 11);
    const qty = String(Number(row.quantity_ordered || 0)).padStart(3);
    const cost = money(row.extended_cost).padStart(9);
    lines.push({ text: `${sku} ${product} ${size} ${grind} ${qty} ${cost}`, size: 9, mono: true });
    if (row.manual) {
      const note = [`Recipient: ${row.recipient_name || "Unspecified"}`, row.reason ? `Reason: ${row.reason}` : "", row.notes ? `Notes: ${row.notes}` : ""].filter(Boolean).join(" | ");
      for (const wrapped of wrap(note, 88)) lines.push({ text: `  ${wrapped}`, size: 8, mono: true });
    }
  }
  lines.push({ text: "-------------------------------------------------------------------------------", size: 9 });
  lines.push({ text: `TOTAL BAGS: ${totalBags}                                      ESTIMATED TOTAL: ${money(totalCost)}`, size: 10, bold: true, gap: 10 });
  if (po.notes) {
    lines.push({ text: "Notes:", size: 10, bold: true });
    for (const wrapped of wrap(po.notes, 95)) lines.push({ text: wrapped, size: 9 });
  }
  lines.push({ text: "Thank you for supporting Friends of 323.", size: 9, gap: 0 });
  return makeSimplePdf(lines);
}
function fit(value, length) { const s = String(value ?? "").replace(/\s+/g, " "); return (s.length > length ? s.slice(0, Math.max(0, length - 1)) + "…" : s).padEnd(length); }
function wrap(value, width) {
  const words = String(value ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = []; let line = "";
  for (const word of words) { if (!line) line = word; else if ((line + " " + word).length <= width) line += " " + word; else { lines.push(line); line = word; } }
  if (line) lines.push(line); return lines.length ? lines : [""];
}
function formatDate(value) { if (!value) return ""; const [y,m,d] = String(value).slice(0,10).split("-"); return `${m}/${d}/${y}`; }

function makeSimplePdf(lines) {
  const pageHeight = 792, pageWidth = 612, marginX = 45, topY = 742, bottomY = 48;
  const pages = []; let current = []; let y = topY;
  for (const line of lines) {
    const size = line.size || 10; const leading = size + 4 + (line.gap || 0);
    if (y - leading < bottomY && current.length) { pages.push(current); current = []; y = topY; }
    current.push({ ...line, y }); y -= leading;
  }
  if (current.length) pages.push(current);

  const objects = [];
  const add = value => { objects.push(value); return objects.length; };
  const catalogId = add("");
  const pagesId = add("");
  const helveticaId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const helveticaBoldId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const courierId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  const pageIds = [];
  for (const pageLines of pages) {
    const content = pageLines.map(line => {
      const font = line.mono ? "F3" : (line.bold ? "F2" : "F1");
      return `BT /${font} ${line.size || 10} Tf ${marginX} ${line.y} Td (${pdfEscape(line.text)}) Tj ET`;
    }).join("\n");
    const contentBuffer = Buffer.from(content, "binary");
    const contentId = add(`<< /Length ${contentBuffer.length} >>\nstream\n${content}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${helveticaId} 0 R /F2 ${helveticaBoldId} 0 R /F3 ${courierId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf, "binary")); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}
function pdfEscape(value) { return String(value ?? "").replace(/[^\x20-\x7E]/g, "?").replace(/([\\()])/g, "\\$1"); }

function encodeHeader(value) { const text = String(value ?? ""); return /^[\x20-\x7E]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`; }
function smtpCommand(socket, command, acceptedCodes) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => { socket.off("data", onData); socket.off("error", onError); socket.off("timeout", onTimeout); };
    const onError = error => { cleanup(); reject(error); };
    const onTimeout = () => { cleanup(); reject(new Error("Gmail SMTP connection timed out.")); };
    const onData = chunk => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      if (!lines.length) return;
      const last = lines[lines.length - 1];
      if (!/^\d{3} /.test(last)) return;
      const code = Number(last.slice(0,3)); cleanup();
      acceptedCodes.includes(code) ? resolve(buffer) : reject(new Error(`Gmail SMTP error ${code}: ${last.slice(4)}`));
    };
    socket.on("data", onData); socket.on("error", onError); socket.on("timeout", onTimeout);
    if (command !== null) socket.write(`${command}\r\n`);
  });
}
async function sendGmailSmtp({ user, appPassword, to, subject, text, html, attachment }) {
  const socket = tls.connect({ host: "smtp.gmail.com", port: 465, servername: "smtp.gmail.com", rejectUnauthorized: true });
  socket.setTimeout(20000);
  await smtpCommand(socket, null, [220]);
  await smtpCommand(socket, "EHLO friendsof323.netlify.app", [250]);
  await smtpCommand(socket, "AUTH LOGIN", [334]);
  await smtpCommand(socket, Buffer.from(user, "utf8").toString("base64"), [334]);
  await smtpCommand(socket, Buffer.from(appPassword.replace(/\s+/g, ""), "utf8").toString("base64"), [235]);
  await smtpCommand(socket, `MAIL FROM:<${user}>`, [250]);
  await smtpCommand(socket, `RCPT TO:<${to}>`, [250,251]);
  await smtpCommand(socket, "DATA", [354]);

  const mixed = `f323_mixed_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const alt = `f323_alt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const b64 = attachment.buffer.toString("base64").match(/.{1,76}/g).join("\r\n");
  const message = [
    `From: ${encodeHeader("Friends of 323 Coffee")} <${user}>`, `To: <${to}>`, `Subject: ${encodeHeader(subject)}`, "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`, "",
    `--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, "",
    `--${alt}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", text, "",
    `--${alt}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", html, "",
    `--${alt}--`, "",
    `--${mixed}`, `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${attachment.filename}"`, "", b64, "",
    `--${mixed}--`, ""
  ].join("\r\n").replace(/^\./gm, "..");
  await smtpCommand(socket, `${message}\r\n.`, [250]);
  await smtpCommand(socket, "QUIT", [221]);
  socket.end();
}
