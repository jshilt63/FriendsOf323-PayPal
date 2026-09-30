import { requirePortalUser } from "../../assets/auth-common.js";
import { renderPortalLayout, escapeHtml } from "../components/layout.js?v=1.9.0";
import { hasMinimumRole } from "../shared/roles.js";
import { PurchaseOrdersService } from "../services/purchase-orders-service.js";
import {
  clearNotice, closeDialog, openDialog, setFormBusy, setNotice
} from "../master-data/shared.js";

const result = await requirePortalUser();
if (result) await initialize(result);

async function initialize({ user, profile }) {
  const canCreate = hasMinimumRole(profile.role, "coffee_bean");
  const content = renderPortalLayout({
    profile,
    user,
    pageTitle: "Roaster"
  });

  content.innerHTML = `
    <div class="breadcrumb">Committee Portal / Roaster / Roaster Orders</div>
    <div class="page-heading">
      <div>
        <h1>Roaster Orders</h1>
        <p>Select paid coffee lines and create one purchase order per supplier. New purchase orders remain editable until submitted.</p>
      </div>
      <div class="page-actions">
        <a class="portal-button portal-button--secondary"
           href="/committee/purchase-orders.html">Purchase Orders</a>
        <button class="portal-button portal-button--secondary"
                id="print-list" type="button">Print List</button>
        <button class="portal-button portal-button--secondary"
                id="export-list" type="button">Export CSV</button>
      </div>
    </div>

    <div id="page-notice" class="notice" hidden></div>

    <section class="roaster-summary" id="roaster-summary"></section>
    <div id="supplier-groups"></div>

    ${canCreate ? createDialog() : ""}
  `;

  const notice = document.querySelector("#page-notice");
  let rows = [];
  const selected = new Map();

  document.querySelector("#print-list").addEventListener("click", () => window.print());
  document.querySelector("#export-list").addEventListener("click", exportCsv);

  if (canCreate) setupCreateDialog();

  async function load() {
    try {
      rows = await PurchaseOrdersService.readyItems();
      selected.clear();
      render();
    } catch (error) {
      setNotice(notice, error.message, "error");
    }
  }

  function render() {
    const suppliers = groupBy(rows, row => row.supplier_name);

    document.querySelector("#roaster-summary").innerHTML = `
      <article><span>Customer Orders</span><strong>${new Set(rows.map(row => row.order_id)).size}</strong></article>
      <article><span>Total Bags</span><strong>${sum(rows, "quantity_available")}</strong></article>
      <article><span>Suppliers</span><strong>${suppliers.size}</strong></article>
      <article><span>Ready Lines</span><strong>${rows.length}</strong></article>
    `;

    const target = document.querySelector("#supplier-groups");
    if (!rows.length) {
      target.innerHTML = `
        <section class="panel roaster-empty">
          <h2>Nothing is waiting to be ordered</h2>
          <p>Paid, unallocated order lines appear here until they are assigned to a draft purchase order.</p>
          <a class="portal-button portal-button--secondary"
             href="/committee/orders.html">View All Orders</a>
        </section>`;
      return;
    }

    target.innerHTML = [...suppliers.entries()]
      .map(([supplier, supplierRows]) => renderSupplier(supplier, supplierRows, canCreate))
      .join("");

    if (canCreate) bindSelection();
  }

  function bindSelection() {
    document.querySelectorAll("[data-select-line]").forEach(checkbox => {
      checkbox.addEventListener("change", () => {
        const row = rows.find(item => item.order_item_id === checkbox.dataset.selectLine);
        if (!row) return;
        if (checkbox.checked) {
          selected.set(row.order_item_id, {
            order_item_id: row.order_item_id,
            quantity: Number(row.quantity_available),
            supplier_name: row.supplier_name
          });
        } else {
          selected.delete(row.order_item_id);
        }
        updateSupplierActions(row.supplier_name);
      });
    });

    document.querySelectorAll("[data-select-supplier]").forEach(checkbox => {
      checkbox.addEventListener("change", () => {
        const supplier = checkbox.dataset.selectSupplier;
        document.querySelectorAll(`[data-supplier-line="${cssEscape(supplier)}"]`)
          .forEach(lineCheckbox => {
            lineCheckbox.checked = checkbox.checked;
            lineCheckbox.dispatchEvent(new Event("change"));
          });
      });
    });

    document.querySelectorAll("[data-create-po]").forEach(button => {
      button.addEventListener("click", () => {
        const supplier = button.dataset.createPo;
        const supplierLines = [...selected.values()]
          .filter(line => line.supplier_name === supplier);
        openCreateDialog(supplier, supplierLines);
      });
    });
  }

  function updateSupplierActions(supplier) {
    const count = [...selected.values()]
      .filter(line => line.supplier_name === supplier).length;
    const bags = [...selected.values()]
      .filter(line => line.supplier_name === supplier)
      .reduce((total, line) => total + line.quantity, 0);

    const button = document.querySelector(`[data-create-po="${cssEscape(supplier)}"]`);
    if (button) {
      button.disabled = count === 0;
      button.textContent = count
        ? `Create Purchase Order · ${bags} bag${bags === 1 ? "" : "s"}`
        : "Create Purchase Order";
      button.title = count
        ? `Create a draft purchase order for ${bags} selected bag${bags === 1 ? "" : "s"}.`
        : "Select at least one order line below to create a draft purchase order.";
    }
  }

  function setupCreateDialog() {
    const dialog = document.querySelector("#create-po-dialog");
    const form = document.querySelector("#create-po-form");
    const dialogNotice = document.querySelector("#create-po-notice");

    dialog.querySelectorAll("[data-close]").forEach(button =>
      button.addEventListener("click", () => closeDialog(dialog)));

    form.addEventListener("submit", async event => {
      event.preventDefault();
      clearNotice(dialogNotice);

      const supplier = form.elements.supplier_name.value;
      const lines = [...selected.values()]
        .filter(line => line.supplier_name === supplier)
        .map(line => ({
          order_item_id: line.order_item_id,
          quantity: line.quantity
        }));

      setFormBusy(form, true, "Creating draft…");
      try {
        const purchaseOrderId = await PurchaseOrdersService.createDraft({
          supplierName: supplier,
          lines,
          notes: form.elements.notes.value.trim() || null
        });
        closeDialog(dialog);
        window.location.href =
          `/committee/purchase-order.html?id=${encodeURIComponent(purchaseOrderId)}`;
      } catch (error) {
        setNotice(dialogNotice, error.message, "error");
      } finally {
        setFormBusy(form, false);
      }
    });
  }

  function openCreateDialog(supplier, lines) {
    if (!lines.length) return;
    const dialog = document.querySelector("#create-po-dialog");
    const form = document.querySelector("#create-po-form");
    clearNotice(document.querySelector("#create-po-notice"));
    form.reset();
    form.elements.supplier_name.value = supplier;
    document.querySelector("#create-po-title").textContent =
      `Create Purchase Order — ${supplier}`;
    document.querySelector("#create-po-summary").innerHTML = `
      <strong>${lines.reduce((total, line) => total + line.quantity, 0)}
        bag${lines.reduce((total, line) => total + line.quantity, 0) === 1 ? "" : "s"}</strong>
      across ${lines.length} selected order line${lines.length === 1 ? "" : "s"}.
    `;
    openDialog(dialog);
  }

  function exportCsv() {
    const headings = [
      "Supplier", "Supplier Product", "Portal Product", "SKU", "Bag Size",
      "Grind", "Quantity Available", "Order", "Ecwid Order", "Customer", "Scout"
    ];
    const values = rows.map(row => [
      row.supplier_name,
      row.supplier_product_name,
      row.portal_product_name,
      row.sku,
      row.bag_size,
      labelGrind(row.grind),
      row.quantity_available,
      row.order_number,
      row.ecwid_order_number,
      customerName(row),
      scoutName(row)
    ]);
    const csv = [headings, ...values]
      .map(row => row.map(csvCell).join(","))
      .join("\r\n");
    downloadCsv(csv, "friends-323-ready-to-order.csv");
  }

  await load();
}

function renderSupplier(supplier, rows, canCreate) {
  const summary = aggregateProducts(rows);
  const totalBags = sum(rows, "quantity_available");
  const supplierKey = escapeHtml(supplier);

  return `
    <section class="panel supplier-order-group">
      <div class="supplier-order-group__heading">
        <div>
          <p class="section-eyebrow">Supplier</p>
          <h2>${supplierKey}</h2>
        </div>
        <div class="supplier-heading-actions">
          <strong>${totalBags} bag${totalBags === 1 ? "" : "s"}</strong>
          ${canCreate ? `
            <button class="portal-button" type="button"
                    data-create-po="${supplierKey}"
                    title="Select at least one order line below to create a draft purchase order."
                    disabled>
              Create Purchase Order
            </button>
          ` : ""}
        </div>
      </div>

      <div class="supplier-product-summary">
        ${summary.map(row => `
          <article>
            <strong>${escapeHtml(row.supplier_product_name)}</strong>
            <span>${escapeHtml(row.bag_size)} · ${escapeHtml(labelGrind(row.grind))}</span>
            <b>${row.quantity}</b>
          </article>
        `).join("")}
      </div>

      <div class="table-wrap">
        <table class="data-table ready-order-table">
          <thead>
            <tr>
              ${canCreate ? `
                <th class="selection-cell">
                  <input type="checkbox"
                         data-select-supplier="${supplierKey}"
                         aria-label="Select all ${supplierKey} lines">
                </th>` : ""}
              <th>Order</th>
              <th>Customer</th>
              <th>Supplier Product</th>
              <th>Portal Product</th>
              <th>Size</th>
              <th>Grind</th>
              <th>Scout</th>
              <th>Available</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(row => `
              <tr>
                ${canCreate ? `
                  <td class="selection-cell">
                    <input type="checkbox"
                           data-select-line="${row.order_item_id}"
                           data-supplier-line="${supplierKey}"
                           aria-label="Select order #${row.order_number}">
                  </td>` : ""}
                <td>
                  <a href="/committee/orders.html?order=${row.order_id}">
                    #${row.order_number}
                  </a>
                  ${row.ecwid_order_number
                    ? `<div class="cell-note">Ecwid ${escapeHtml(row.ecwid_order_number)}</div>`
                    : ""}
                </td>
                <td>${escapeHtml(customerName(row))}</td>
                <td><strong>${escapeHtml(row.supplier_product_name)}</strong></td>
                <td>${escapeHtml(row.portal_product_name)}
                  <div class="cell-note">${escapeHtml(row.sku)}</div>
                </td>
                <td>${escapeHtml(row.bag_size)}</td>
                <td><span class="grind-badge">${escapeHtml(labelGrind(row.grind))}</span></td>
                <td>${escapeHtml(scoutName(row))}</td>
                <td><strong>${row.quantity_available}</strong></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>`;
}

function createDialog() {
  return `
    <dialog class="portal-dialog" id="create-po-dialog">
      <form class="dialog-card" id="create-po-form">
        <div class="dialog-header">
          <h2 id="create-po-title">Create Purchase Order</h2>
          <button class="icon-button" type="button" data-close>×</button>
        </div>
        <input type="hidden" name="supplier_name">
        <p id="create-po-summary"></p>
        <label class="form-field">
          <span>Internal notes</span>
          <textarea name="notes" rows="4"
                    placeholder="Optional notes for this purchase order"></textarea>
        </label>
        <div id="create-po-notice" class="notice" hidden></div>
        <div class="dialog-actions">
          <button class="portal-button portal-button--secondary"
                  type="button" data-close>Cancel</button>
          <button class="portal-button" type="submit">Create Draft</button>
        </div>
      </form>
    </dialog>`;
}

function aggregateProducts(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = [row.product_id, row.grind].join("|");
    if (!grouped.has(key)) {
      grouped.set(key, {
        supplier_product_name: row.supplier_product_name,
        bag_size: row.bag_size,
        grind: row.grind,
        quantity: 0
      });
    }
    grouped.get(key).quantity += Number(row.quantity_available || 0);
  }
  return [...grouped.values()];
}

function groupBy(rows, keyFn) {
  const map = new Map();
  rows.forEach(row => {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}

function customerName(row) {
  return [row.customer_first_name, row.customer_last_name]
    .filter(Boolean).join(" ")
    || row.customer_company_name
    || "Unnamed Customer";
}

function scoutName(row) {
  return row.is_general_fund
    ? "General Fund"
    : [row.scout_first_name, row.scout_last_name].filter(Boolean).join(" ")
      || "Unknown Scout";
}

function labelGrind(value) {
  return value === "whole_bean" ? "Whole Bean" : "Ground";
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function cssEscape(value) {
  return CSS.escape(String(value));
}
