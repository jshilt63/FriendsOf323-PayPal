import { requirePortalUser } from "../../assets/auth-common.js";
import { renderPortalLayout, escapeHtml } from "../components/layout.js?v=1.9.32";
import { PurchaseOrdersService } from "../services/purchase-orders-service.js";
import { setNotice } from "../master-data/shared.js";
import { confirmAction } from "../components/confirm-dialog.js?v=1.9.4";

const result = await requirePortalUser();
if (result) await initialize(result);

async function initialize({ user, profile }) {
  const id = new URLSearchParams(window.location.search).get("id");
  const content = renderPortalLayout({ profile, user, pageTitle: "Purchase Order" });
  const canManage = profile.role === "coffee_bean";
  let references = { products: [], customers: [] };
  let currentOrder = null;

  content.innerHTML = `
    <div class="breadcrumb">Committee Portal / Roaster Orders /
      <a href="/committee/purchase-orders.html">Purchase Orders</a>
    </div>
    <div id="page-notice" class="notice" hidden></div>
    <div id="purchase-order-detail"></div>
    ${manualLineDialog()}
    ${submitDialog()}
    ${exceptionDialog()}
    <div id="delivery-print-area"></div>
  `;

  const notice = document.querySelector("#page-notice");
  if (!id) {
    setNotice(notice, "A purchase-order ID is required.", "error");
    return;
  }

  try {
    references = await PurchaseOrdersService.references();
  } catch (error) {
    setNotice(notice, error.message, "error");
  }

  await load();

  async function load() {
    try {
      const data = await PurchaseOrdersService.get(id);
      currentOrder = data.purchaseOrder;
      render(data.purchaseOrder, data.items, data.allocations, data.manualItems || []);
    } catch (error) {
      setNotice(notice, error.message, "error");
    }
  }

  function render(order, items, allocations, manualItems) {
    const target = document.querySelector("#purchase-order-detail");
    const grouped = groupBy(allocations, row => row.purchase_order_item_id);
    const statusLabel = labelStatus(order.status);
    const allBagCount = sum(items, "quantity_ordered") + sum(manualItems, "quantity_ordered");
    const allCost = sum(items, "extended_cost") + sum(manualItems, "extended_cost");

    target.innerHTML = `
      <div class="page-heading purchase-order-heading">
        <div>
          <p class="section-eyebrow">${escapeHtml(statusLabel)} Purchase Order</p>
          <h1>${escapeHtml(order.po_number)}</h1>
          <p>${escapeHtml(order.supplier_name)}</p>
        </div>
        <div class="page-actions">
          ${renderWorkflowActions(order, canManage)}
          ${canManage && order.status === "draft" ? `
            <button class="portal-button portal-button--secondary" id="refresh-draft-po" type="button">Refresh Draft PO</button>
            <button class="portal-button" id="add-manual-line" type="button">Add Manual Line</button>
          ` : ""}
          <button class="portal-button portal-button--secondary" id="print-purchase-order" type="button">Print Purchase Order</button>
          <a class="portal-button portal-button--secondary" href="/committee/purchase-orders.html">Purchase Orders</a>
        </div>
      </div>

      <section class="purchase-order-meta panel">
        <div><span>Status</span><strong>${escapeHtml(statusLabel)}</strong></div>
        <div><span>Order Date</span><strong>${formatDate(order.order_date)}</strong></div>
        <div><span>Supplier</span><strong>${escapeHtml(order.supplier_name)}</strong></div>
        <div><span>Total Bags</span><strong>${allBagCount}</strong></div>
        ${order.submitted_at ? `<div><span>Submitted</span><strong>${formatDateTime(order.submitted_at)}</strong></div>` : ""}
        ${order.received_at ? `<div><span>Received</span><strong>${formatDateTime(order.received_at)}</strong></div>` : ""}

      </section>

      ${order.notes ? `<section class="panel purchase-order-notes"><h2>Notes</h2><p>${escapeHtml(order.notes)}</p></section>` : ""}

      <section class="panel purchase-order-summary-panel">
        <div class="section-heading">
          <div><h2>Supplier Summary</h2><p>Grouped by supplier product, size, and Whole Bean/Ground.</p></div>
        </div>
        <div class="table-wrap purchase-order-table-wrap">
          <table class="data-table purchase-order-table">
            <thead><tr><th>Supplier Product</th><th>Portal Product</th><th>Size</th><th>Grind</th><th>Quantity</th><th>Estimated Cost</th></tr></thead>
            <tbody>
              ${items.map(item => `
                <tr>
                  <td><strong>${escapeHtml(item.supplier_product_name)}</strong></td>
                  <td>${escapeHtml(item.portal_product_name)}<div class="cell-note">${escapeHtml(item.sku)}</div></td>
                  <td>${escapeHtml(item.bag_size)}</td>
                  <td><span class="grind-badge">${labelGrind(item.grind)}</span></td>
                  <td><strong>${item.quantity_ordered}</strong></td>
                  <td>${money(item.extended_cost)}</td>
                </tr>
                <tr class="allocation-detail-row"><td colspan="6">${renderAllocations(grouped.get(item.id) || [])}</td></tr>
              `).join("")}
              ${manualItems.map(item => `
                <tr class="manual-po-row">
                  <td><strong>${escapeHtml(item.supplier_product_name)}</strong><div class="manual-line-badge">MANUAL</div></td>
                  <td>${escapeHtml(item.portal_product_name)}<div class="cell-note">${escapeHtml(item.sku)}</div></td>
                  <td>${escapeHtml(item.bag_size)}</td>
                  <td><span class="grind-badge">${labelGrind(item.grind)}</span></td>
                  <td><strong>${item.quantity_ordered}</strong></td>
                  <td>${item.no_charge ? "<strong>No Charge</strong>" : money(item.extended_cost)}</td>
                </tr>
                <tr class="allocation-detail-row manual-po-detail">
                  <td colspan="6">
                    <div class="allocation-list">
                      <div>
                        <span><strong>Customer / Recipient:</strong> ${escapeHtml(item.recipient_name)}</span>
                        <span><strong>Reason:</strong> ${escapeHtml(item.reason)}</span>
                        ${item.notes ? `<span>${escapeHtml(item.notes)}</span>` : ""}
                        ${canManage && order.status === "draft" ? `<button class="text-button" data-delete-manual="${item.id}" type="button">Remove</button>` : ""}
                      </div>
                    </div>
                  </td>
                </tr>
              `).join("")}
            </tbody>
            <tfoot><tr><td colspan="4"><strong>Purchase Order Total</strong></td><td><strong>${allBagCount}</strong></td><td><strong>${money(allCost)}</strong></td></tr></tfoot>
          </table>
        </div>
      </section>

      <section class="panel delivery-tools-panel">
        <div class="section-heading">
          <div>
            <h2>Customer Delivery</h2>
            <p>Print packing sheets from Orders. Here you can hold a received bag because of a roaster error, quality issue, damage, or another problem.</p>
          </div>
          ${canManage ? `<button class="portal-button portal-button--secondary" id="add-fulfillment-exception" type="button">Mark Item Outstanding</button>` : ""}
        </div>
      </section>
    `;

    document.querySelector("#print-purchase-order")?.addEventListener("click", () => {
      document.body.classList.remove("printing-delivery-sheets");
      document.body.classList.add("printing-purchase-order");
      window.print();
      setTimeout(() => document.body.classList.remove("printing-purchase-order"), 250);
    });
    document.querySelector("#mark-submitted")?.addEventListener("click", openSubmitDialog);
    document.querySelector("#mark-received")?.addEventListener("click", () => changeStatus("received"));
    document.querySelector("#refresh-draft-po")?.addEventListener("click", refreshDraft);
    document.querySelector("#add-manual-line")?.addEventListener("click", openManualDialog);
    document.querySelector("#add-fulfillment-exception")?.addEventListener("click", openExceptionDialog);
    document.querySelectorAll("[data-delete-manual]").forEach(button => {
      button.addEventListener("click", async () => {
        if (!await confirmAction({ title: "Remove Manual Line?", message: "Remove this manual line from the purchase order?", confirmLabel: "Remove Line", urgent: true })) return;
        try {
          await PurchaseOrdersService.deleteManualItem(button.dataset.deleteManual);
          await load();
        } catch (error) { setNotice(notice, error.message, "error"); }
      });
    });
  }

  function openManualDialog() {
    const dialog = document.querySelector("#manual-po-line-dialog");
    const form = dialog.querySelector("form");
    form.reset();

    const products = references.products.filter(p =>
      String(p.supplier_name || "").trim().toLowerCase() === String(currentOrder.supplier_name || "").trim().toLowerCase()
    );
    form.elements.product_id.innerHTML = `<option value="">Choose product…</option>` +
      products.map(p => `<option value="${p.id}">${escapeHtml(p.product_name)} — ${escapeHtml(p.bag_size)}</option>`).join("");
    form.elements.customer_id.innerHTML = `<option value="">No portal customer / use recipient name</option>` +
      references.customers.map(c => `<option value="${c.id}">${escapeHtml(customerName(c))}</option>`).join("");
    dialog.showModal();
  }

  document.querySelector("#manual-po-line-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    const customerId = fd.get("customer_id") || null;
    const recipient = String(fd.get("recipient_name") || "").trim();
    if (!customerId && !recipient) {
      setNotice(document.querySelector("#manual-line-notice"), "Choose a customer or enter a recipient name.", "error");
      return;
    }
    try {
      await PurchaseOrdersService.addManualItem({
        purchase_order_id: id,
        product_id: fd.get("product_id"),
        customer_id: customerId,
        recipient_name: recipient || null,
        grind: fd.get("grind"),
        quantity_ordered: Number(fd.get("quantity_ordered")),
        no_charge: fd.get("no_charge") === "on",
        unit_cost: Number(fd.get("unit_cost") || 0),
        reason: String(fd.get("reason") || "").trim(),
        notes: String(fd.get("notes") || "").trim() || null,
        created_by: user.id,
        updated_by: user.id
      });
      document.querySelector("#manual-po-line-dialog").close();
      setNotice(notice, "Manual purchase-order line added.", "success");
      await load();
    } catch (error) {
      setNotice(document.querySelector("#manual-line-notice"), error.message, "error");
    }
  });

  async function openExceptionDialog() {
    const dialog = document.querySelector("#fulfillment-exception-dialog");
    const form = dialog.querySelector("form");
    form.reset();
    try {
      const items = await PurchaseOrdersService.deliveryItems();
      const candidates = items.filter(row => Number(row.quantity_roaster_received || 0) > 0 && Number(row.quantity_delivering || 0) > 0);
      form.elements.order_item_id.innerHTML = `<option value="">Choose customer item…</option>` +
        candidates.map(row => `<option value="${row.order_item_id}" data-max="${row.quantity_delivering}">
          ${escapeHtml(row.customer_name)} — Order #${row.order_number} — ${escapeHtml(row.product_name)} ${escapeHtml(row.bag_size)} ${escapeHtml(row.grind_label)} (${row.quantity_delivering} available)
        </option>`).join("");
      dialog.showModal();
    } catch (error) {
      setNotice(notice, error.message, "error");
    }
  }

  document.querySelector("#fulfillment-exception-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    const option = form.elements.order_item_id.selectedOptions[0];
    const max = Number(option?.dataset.max || 0);
    const qty = Number(fd.get("quantity"));
    if (qty < 1 || qty > max) {
      setNotice(document.querySelector("#exception-notice"), `Quantity must be between 1 and ${max}.`, "error");
      return;
    }
    try {
      await PurchaseOrdersService.addException({
        order_item_id: fd.get("order_item_id"),
        quantity: qty,
        reason: fd.get("reason"),
        notes: String(fd.get("notes") || "").trim() || null,
        created_by: user.id,
        updated_by: user.id
      });
      dialog.close();
      setNotice(notice, "Item marked outstanding for customer delivery.", "success");
    } catch (error) {
      setNotice(document.querySelector("#exception-notice"), error.message, "error");
    }
  });

  async function printDeliverySheets() {
    if (!currentOrder || currentOrder.status !== "received") {
      setNotice(
        notice,
        "Delivery sheets are available after the purchase order has been marked Received.",
        "error"
      );
      return;
    }

    try {
      const [rows, manualItems] = await Promise.all([
        PurchaseOrdersService.deliveryItems(),
        supabaseManualItemsForCurrentPo()
      ]);

      // Customers touched by this PO, either through normal allocations or manual lines.
      const allocations = await PurchaseOrdersService.allocationDetails(id);
      const customerIds = new Set(allocations.map(a => a.customer_id).filter(Boolean));
      manualItems.forEach(m => { if (m.customer_id) customerIds.add(m.customer_id); });

      const customerRows = rows.filter(r => customerIds.has(r.customer_id));
      const grouped = groupBy(customerRows, r => r.customer_id);
      const target = document.querySelector("#delivery-print-area");

      const sheets = [];
      for (const [customerId, items] of grouped.entries()) {
        const first = items[0];
        const manuals = manualItems.filter(m => m.customer_id === customerId && m.quantity_received > 0);
        sheets.push(renderDeliverySheet(first, items, manuals));
      }

      // Manual recipient without a customer record gets a simple recipient sheet.
      const looseManuals = manualItems.filter(m => !m.customer_id && m.quantity_received > 0);
      for (const [recipient, items] of groupBy(looseManuals, m => m.recipient_name).entries()) {
        sheets.push(renderManualRecipientSheet(recipient, items));
      }

      if (!sheets.length) {
        setNotice(notice, "No customer delivery sheets are available for this purchase order yet.", "error");
        return;
      }

      target.innerHTML = sheets.join("");
      document.body.classList.remove("printing-purchase-order");
      document.body.classList.add("printing-delivery-sheets");
      window.print();
      setTimeout(() => document.body.classList.remove("printing-delivery-sheets"), 250);
    } catch (error) {
      setNotice(notice, error.message, "error");
    }
  }

  async function supabaseManualItemsForCurrentPo() {
    const data = await PurchaseOrdersService.get(id);
    return data.manualItems || [];
  }

  async function refreshDraft() {
    if (!currentOrder || currentOrder.status !== "draft") return;

    const button = document.querySelector("#refresh-draft-po");
    const originalText = button?.textContent || "Refresh Draft PO";

    if (!await confirmAction({
      title: "Refresh Purchase Order?",
      message: `Refresh ${currentOrder.po_number} with any new paid, unallocated ${currentOrder.supplier_name} coffee orders?\n\nExisting PO allocations and manual lines will remain unchanged.`,
      confirmLabel: "Refresh Purchase Order"
    })) return;

    if (button) {
      button.disabled = true;
      button.textContent = "Refreshing…";
    }

    try {
      const result = await PurchaseOrdersService.refreshDraft(id);
      const addedBags = Number(result?.bags_added || 0);
      const addedLines = Number(result?.order_lines_added || 0);

      if (addedBags > 0) {
        setNotice(
          notice,
          `${addedBags} new bag${addedBags === 1 ? "" : "s"} from ${addedLines} customer-order line${addedLines === 1 ? "" : "s"} added to ${currentOrder.po_number}.`,
          "success"
        );
      } else {
        setNotice(
          notice,
          `No new ${currentOrder.supplier_name} coffee orders are waiting to be added to ${currentOrder.po_number}.`,
          "success"
        );
      }

      await load();
    } catch (error) {
      setNotice(notice, error.message, "error");
    } finally {
      if (button && document.body.contains(button)) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  }

  async function openSubmitDialog() {
    const dialog = document.querySelector("#submit-po-dialog");
    const form = dialog.querySelector("form");
    form.reset();
    form.querySelector("#submit-roaster-email").textContent = "Loading saved roaster address…";
    setNotice(document.querySelector("#submit-po-notice"), "", "error");
    dialog.showModal();
    try {
      const email = await PurchaseOrdersService.supplierEmail(currentOrder.supplier_name);
      form.querySelector("#submit-roaster-email").textContent = email || "No email saved. Set it under Administration → Roaster.";
      form.querySelector('[type="submit"]').disabled = !email;
    } catch (error) { setNotice(document.querySelector("#submit-po-notice"), error.message, "error"); }
  }

  document.querySelector("#submit-po-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    button.textContent = "Sending…";
    try {
      const sent = await PurchaseOrdersService.submit(id);
      document.querySelector("#submit-po-dialog").close();
      setNotice(notice, `${sent.po_number} was emailed to ${sent.recipient_email} with its PDF and marked submitted.`, "success");
      await load();
    } catch (error) {
      setNotice(document.querySelector("#submit-po-notice"), error.message, "error");
      await load();
    } finally { button.disabled = false; button.textContent = "Email and Submit"; }
  });

  async function changeStatus(nextStatus) {
    if (!await confirmAction({
      title: "Receive Purchase Order?",
      message: "All normal and manual quantities on this purchase order will be recorded as received.",
      confirmLabel: "Mark Received"
    })) return;
    try {
      await PurchaseOrdersService.transition(id, nextStatus);
      setNotice(notice, "Purchase order marked as received.", "success");
      await load();
    } catch (error) { setNotice(notice, error.message, "error"); }
  }
}

function submitDialog() {
  return `<dialog class="portal-dialog" id="submit-po-dialog">
    <form method="post" class="dialog-card" id="submit-po-form">
      <div class="dialog-header"><div><p class="section-eyebrow">Roaster Order</p><h2>Email and Submit Purchase Order</h2></div><button type="button" class="icon-button" data-close-submit>×</button></div>
      <p class="dialog-help">This sends the purchase order PDF to the saved address for this supplier and marks the order submitted when delivery succeeds.</p>
      <p><strong>Roaster email:</strong> <span id="submit-roaster-email"></span></p>
      <div id="submit-po-notice" class="notice" hidden></div>
      <div class="dialog-actions"><button type="button" class="portal-button portal-button--secondary" data-close-submit>Cancel</button><button class="portal-button" type="submit">Email and Submit</button></div>
    </form>
  </dialog>`;
}

function manualLineDialog() {
  return `<dialog class="portal-dialog portal-dialog--wide" id="manual-po-line-dialog">
    <form method="post" class="dialog-card" id="manual-po-line-form">
      <div class="dialog-header"><div><p class="section-eyebrow">Purchase Order Adjustment</p><h2>Add Manual Line</h2></div><button type="button" class="icon-button" data-close-manual>×</button></div>
      <p class="dialog-help">Use this for a correction, replacement, giveaway, or any bag the roaster needs to process without creating another customer order.</p>
      <div class="form-grid">
        <label class="form-field form-field--full"><span>Product</span><select name="product_id" required></select></label>
        <label class="form-field"><span>Grind</span><select name="grind" required><option value="whole_bean">Whole Bean</option><option value="ground">Ground</option></select></label>
        <label class="form-field"><span>Quantity</span><input name="quantity_ordered" type="number" min="1" step="1" value="1" required></label>
        <label class="form-field form-field--full"><span>Customer</span><select name="customer_id"></select></label>
        <label class="form-field form-field--full"><span>Recipient name (for giveaway or person not in portal)</span><input name="recipient_name"></label>
        <label class="form-field"><span>Reason</span><select name="reason" required><option value="Order correction">Order correction</option><option value="Replacement">Replacement</option><option value="Quality replacement">Quality replacement</option><option value="Giveaway / Complimentary">Giveaway / Complimentary</option><option value="Other">Other</option></select></label>
        <label class="form-field"><span>Unit cost</span><input name="unit_cost" type="number" min="0" step=".01" value="0"></label>
        <label class="checkbox-field form-field--full"><input name="no_charge" type="checkbox" checked><span><strong>No Charge / Already Paid</strong><br>Keep this line at $0.00 on the PO.</span></label>
        <label class="form-field form-field--full"><span>Notes</span><textarea name="notes" placeholder="Explain what the roaster should know."></textarea></label>
      </div>
      <div id="manual-line-notice" class="notice" hidden></div>
      <div class="dialog-actions"><button type="button" class="portal-button portal-button--secondary" data-close-manual>Cancel</button><button class="portal-button" type="submit">Add to PO</button></div>
    </form>
  </dialog>`;
}

function exceptionDialog() {
  return `<dialog class="portal-dialog portal-dialog--wide" id="fulfillment-exception-dialog">
    <form method="post" class="dialog-card" id="fulfillment-exception-form">
      <div class="dialog-header"><div><p class="section-eyebrow">Customer Fulfillment</p><h2>Mark Item Outstanding</h2></div><button type="button" class="icon-button" data-close-exception>×</button></div>
      <p class="dialog-help">Use this when the PO was received but a bag cannot be delivered because of a roaster error, quality issue, damage, or another problem. This does not change the PO back to unreceived.</p>
      <div class="form-grid">
        <label class="form-field form-field--full"><span>Customer item</span><select name="order_item_id" required></select></label>
        <label class="form-field"><span>Quantity held</span><input name="quantity" type="number" min="1" step="1" value="1" required></label>
        <label class="form-field"><span>Reason</span><select name="reason" required><option>Roaster Error</option><option>Quality Issue</option><option>Damaged</option><option>Missing</option><option>Other</option></select></label>
        <label class="form-field form-field--full"><span>Notes</span><textarea name="notes"></textarea></label>
      </div>
      <div id="exception-notice" class="notice" hidden></div>
      <div class="dialog-actions"><button type="button" class="portal-button portal-button--secondary" data-close-exception>Cancel</button><button class="portal-button" type="submit">Mark Outstanding</button></div>
    </form>
  </dialog>`;
}

document.addEventListener("click", event => {
  if (event.target.closest("[data-close-submit]")) document.querySelector("#submit-po-dialog")?.close();
  if (event.target.closest("[data-close-manual]")) document.querySelector("#manual-po-line-dialog")?.close();
  if (event.target.closest("[data-close-exception]")) document.querySelector("#fulfillment-exception-dialog")?.close();
});

function renderDeliverySheet(customer, items, manualItems) {
  const delivering = items.filter(i => Number(i.quantity_delivering) > 0);
  const outstanding = items.filter(i => Number(i.quantity_outstanding) > 0);
  return `<section class="customer-delivery-sheet">
    <header class="delivery-sheet-header">
      <div><p class="section-eyebrow">Friends of 323 Coffee Fundraiser</p><h1>Customer Delivery</h1></div>
      <div class="delivery-sheet-customer"><strong>${escapeHtml(customer.customer_name)}</strong><br>${formatAddress(customer)}</div>
    </header>
    <div class="delivery-sheet-meta">Order(s): ${[...new Set(items.map(i => `#${i.order_number}`))].join(", ")}</div>
    <h2>Delivering Now</h2>
    ${deliveryTable(delivering.map(i => ({ product_name:i.product_name, bag_size:i.bag_size, grind_label:i.grind_label, quantity:i.quantity_delivering, note:"" }))
      .concat(manualItems.map(m => ({ product_name:m.portal_product_name, bag_size:m.bag_size, grind_label:labelGrind(m.grind), quantity:m.quantity_received, note:m.reason }))))}
    <h2 class="${outstanding.length ? "outstanding-heading" : ""}">Outstanding Items</h2>
    ${outstanding.length ? deliveryTable(outstanding.map(i => ({
      product_name:i.product_name, bag_size:i.bag_size, grind_label:i.grind_label, quantity:i.quantity_outstanding,
      note:i.exception_reasons || "Awaiting roaster receipt"
    }))) : `<p class="delivery-all-complete">No outstanding items.</p>`}
    ${outstanding.length ? `<div class="delivery-outstanding-callout"><strong>${sum(outstanding,"quantity_outstanding")} item(s) still outstanding.</strong> These will be delivered separately.</div>` : ""}
    <footer>Thank you for supporting Pack 323.</footer>
  </section>`;
}

function renderManualRecipientSheet(recipient, items) {
  return `<section class="customer-delivery-sheet">
    <header class="delivery-sheet-header"><div><p class="section-eyebrow">Friends of 323 Coffee Fundraiser</p><h1>Delivery</h1></div><div class="delivery-sheet-customer"><strong>${escapeHtml(recipient)}</strong></div></header>
    <h2>Delivering Now</h2>
    ${deliveryTable(items.map(m => ({ product_name:m.portal_product_name, bag_size:m.bag_size, grind_label:labelGrind(m.grind), quantity:m.quantity_received, note:m.reason })))}
    <h2>Outstanding Items</h2><p class="delivery-all-complete">No outstanding items.</p>
    <footer>Thank you for supporting Pack 323.</footer>
  </section>`;
}

function deliveryTable(rows) {
  if (!rows.length) return `<p class="delivery-all-complete">No items in this section.</p>`;
  return `<table class="delivery-sheet-table"><thead><tr><th>Item</th><th>Size</th><th>Grind</th><th>Qty</th><th>Note</th></tr></thead><tbody>${rows.map(r =>
    `<tr><td>${escapeHtml(r.product_name)}</td><td>${escapeHtml(r.bag_size)}</td><td>${escapeHtml(r.grind_label)}</td><td>${r.quantity}</td><td>${escapeHtml(r.note || "")}</td></tr>`
  ).join("")}</tbody></table>`;
}

function formatAddress(c) {
  const lines = [c.address_line_1, c.address_line_2, [c.city, c.state, c.postal_code].filter(Boolean).join(" ")].filter(Boolean);
  return lines.map(escapeHtml).join("<br>") || "No address on file";
}
function customerName(c) { return [c.first_name,c.last_name].filter(Boolean).join(" ") || c.company_name || "Unnamed Customer"; }
function renderWorkflowActions(order, canManage) {
  if (!canManage) return "";
  if (order.status === "draft") return `<button class="portal-button" id="mark-submitted" type="button">Email and Submit</button>`;
  if (["submitted","partially_received"].includes(order.status)) return `<button class="portal-button" id="mark-received" type="button">Mark Received</button>`;
  return "";
}
function renderAllocations(rows) {
  if (!rows.length) return "<p>No customer-order allocations found.</p>";
  return `<div class="allocation-list">${rows.map(row => `<div><a href="/committee/orders.html?order=${row.order_id}">Order #${row.order_number}</a><span>${escapeHtml(row.customer_name)}</span><span>${escapeHtml(row.scout_name)}</span><strong>${row.quantity_allocated}</strong></div>`).join("")}</div>`;
}
function groupBy(rows,keyFn){const m=new Map();rows.forEach(r=>{const k=keyFn(r);if(!m.has(k))m.set(k,[]);m.get(k).push(r)});return m}
function labelStatus(v){return ({draft:"Draft",submitted:"Submitted",partially_received:"Partially Received",received:"Received",cancelled:"Cancelled"})[v]||v}
function labelGrind(v){return v==="whole_bean"?"Whole Bean":"Ground"}
function sum(rows,key){return rows.reduce((t,r)=>t+Number(r[key]||0),0)}
function money(v){return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(v||0))}
function formatDate(v){return v?new Date(`${v}T00:00:00`).toLocaleDateString("en-US"):"—"}
function formatDateTime(v){return v?new Date(v).toLocaleString("en-US",{dateStyle:"short",timeStyle:"short"}):"—"}
