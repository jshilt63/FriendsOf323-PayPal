const FRIENDS_323_STORE_ID = "139808506";

export function parseEcwidOrderEmail(rawSource) {
  const raw = String(rawSource || "");
  const headers = parseHeaders(raw);
  const subject = decodeMimeWords(headers.subject || "");
  const storeId = headers["x-ecwid-store-id"] || "";

  if (storeId && storeId !== FRIENDS_323_STORE_ID) {
    throw new Error("This email is from a different Ecwid store.");
  }
  if (!/^Friends of 323:\s*New order\s+#/i.test(subject)) {
    throw new Error("Select a Friends of 323 Ecwid new-order email (.eml).");
  }

  const text = extractPlainText(raw);
  const normalized = text.replace(/\s+/g, " ").trim();
  const subjectMatch = subject.match(/New order\s+#([^\s]+)\s+from\s+(.+)$/i);
  const orderNumber = subjectMatch?.[1]?.trim() || matchValue(normalized, /New order\s+#([^\s]+)/i);
  const subjectCustomer = subjectMatch?.[2]?.trim() || "";

  const total = numberValue(matchValue(normalized, /New order\s+#[^\s]+\s+Total\s+\$([\d,.]+)/i));
  const dateText = matchValue(normalized, /(?:Awaiting Payment|Paid|Partially Paid)\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}),\s+\d{1,2}:\d{2}\s+(?:AM|PM)/i);
  const paymentLabel = matchValue(normalized, /New order\s+#[^\s]+\s+Total\s+\$[\d,.]+\s+(Awaiting Payment|Paid|Partially Paid)/i);

  const customerSection = matchValue(normalized, /Customer\s+(.+?)\s+Billing Info\s+/i);
  const email = matchValue(customerSection, /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  const customerName = email
    ? customerSection.slice(0, customerSection.toLowerCase().lastIndexOf(email.toLowerCase())).trim()
    : subjectCustomer;

  const billingSection = matchValue(normalized, /Billing Info\s+(.+?)\s+Phone\s+/i);
  const phone = matchValue(normalized, /Phone\s+(.+?)\s+Payment method\s+/i);
  const paymentMethod = matchValue(normalized, /Payment method\s+(.+?)\s+View order details/i);
  const orderComments = matchValue(normalized, /Order comments\s+(.+?)\s+Customer\s+/i);
  const address = parseBillingAddress(billingSection, customerName || subjectCustomer);

  const itemsRegion = matchValue(normalized, /Items\s+(.+?)\s+Subtotal\s+\$[\d,.]+/i);
  const itemPattern = /(.+?)\s+SKU:\s*#?([A-Z0-9-]+)\s+Size:\s*([^\s]+)\s+Grind:\s*(Whole Bean|Ground)\s+Scout you are supporting - Use General for the pack:\s*(.+?)\s+Price per item:\s*\$([\d,.]+)\s+Quantity:\s*(\d+)/gi;
  const items = [];
  let match;
  while ((match = itemPattern.exec(itemsRegion))) {
    let productName = match[1].trim();
    const junk = productName.match(/(?:^|\s)Quantity:\s*\d+\s+(.+)$/i);
    if (junk) productName = junk[1].trim();
    items.push({
      product_name: productName,
      sku: match[2].trim(),
      size: match[3].trim(),
      grind: match[4].trim(),
      scout_name: match[5].trim(),
      unit_price: numberValue(match[6]),
      quantity: Number(match[7])
    });
  }

  if (!orderNumber || !items.length) {
    throw new Error("The email format could not be recognized as a complete Ecwid order.");
  }

  const coffeeTotal = items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
  const nonCoffeeAmount = Math.max(0, Math.round((total - coffeeTotal) * 100) / 100);

  return {
    store_id: storeId || FRIENDS_323_STORE_ID,
    order_number: orderNumber,
    order_date: ecwidDateToIso(dateText),
    payment_status: /paid/i.test(paymentLabel) && !/awaiting/i.test(paymentLabel) ? "paid" : "unpaid",
    amount_paid: /paid/i.test(paymentLabel) && !/awaiting/i.test(paymentLabel) ? total : 0,
    payment_method: paymentMethod,
    order_comments: orderComments,
    ecwid_total: total,
    non_coffee_amount: nonCoffeeAmount,
    customer: {
      first_name: splitName(customerName || subjectCustomer).first,
      last_name: splitName(customerName || subjectCustomer).last,
      email,
      phone,
      ...address
    },
    items
  };
}

function parseHeaders(raw) {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] || "";
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const headers = {};
  unfolded.split(/\r?\n/).forEach(line => {
    const idx = line.indexOf(":");
    if (idx <= 0) return;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  });
  return headers;
}

function extractPlainText(raw) {
  const match = raw.match(/Content-Type:\s*text\/plain[^\r\n]*\r?\n(?:Content-Transfer-Encoding:\s*([^\r\n]+)\r?\n)?\r?\n([\s\S]*?)(?=\r?\n--[-=_A-Za-z0-9]+|$)/i);
  if (!match) return decodeQuotedPrintable(raw);
  const encoding = String(match[1] || "").trim().toLowerCase();
  return encoding.includes("quoted-printable") ? decodeQuotedPrintable(match[2]) : match[2];
}

function decodeQuotedPrintable(value) {
  return String(value || "")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeMimeWords(value) {
  return String(value || "").replace(/=\?UTF-8\?Q\?([^?]+)\?=/gi, (_, encoded) =>
    decodeQuotedPrintable(encoded.replace(/_/g, " "))
  );
}

function matchValue(text, regex) {
  return String(text || "").match(regex)?.[1]?.trim() || "";
}

function numberValue(value) {
  return Number(String(value || "0").replace(/,/g, "")) || 0;
}

function ecwidDateToIso(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const parsed = new Date(`${value} 12:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function splitName(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] || "", last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts.at(-1) };
}

function parseBillingAddress(value, customerName) {
  let clean = String(value || "").trim();
  if (customerName && clean.toLowerCase().startsWith(customerName.toLowerCase())) {
    clean = clean.slice(customerName.length).trim();
  }
  const parts = clean.split(",").map(part => part.trim()).filter(Boolean);
  const stateZip = parts.at(-2) || "";
  const stateMatch = stateZip.match(/^(.+?)\s+(\d{5}(?:-\d{4})?)$/);
  return {
    address_line_1: parts.slice(0, Math.max(1, parts.length - 3)).join(", "),
    address_line_2: "",
    city: parts.length >= 3 ? parts.at(-3) : "",
    state: stateMatch?.[1] || "",
    postal_code: stateMatch?.[2] || ""
  };
}
