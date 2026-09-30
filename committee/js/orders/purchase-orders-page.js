import { requirePortalUser } from "../../assets/auth-common.js";
import { renderPortalLayout, escapeHtml } from "../components/layout.js?v=1.9.0";
import { PurchaseOrdersService } from "../services/purchase-orders-service.js";
import { setNotice } from "../master-data/shared.js";

const result = await requirePortalUser();
if (result) await initialize(result);

async function initialize({ user, profile }) {
  const content = renderPortalLayout({
    profile,
    user,
    pageTitle: "Purchase Orders"
  });

  content.innerHTML = `
    <div class="breadcrumb">Committee Portal / Roaster / Purchase Orders</div>
    <div class="page-heading">
      <div>
        <h1>Purchase Orders</h1>
        <p>Create, review, submit, and track purchase orders through receiving.</p>
      </div>
      <a class="portal-button"
         href="/committee/ready-to-order.html">Create Purchase Order</a>
    </div>

    <div id="page-notice" class="notice" hidden></div>

    <div class="purchase-order-tabs" role="tablist">
      <button class="is-active" type="button" data-status="draft">Open</button>
      <button type="button" data-status="submitted">Submitted</button>
      <button type="button" data-status="partially_received">Partially Received</button>
      <button type="button" data-status="received">Received</button>
      <button type="button" data-status="">All</button>
    </div>

    <section class="panel">
      <div id="purchase-order-list"></div>
    </section>
  `;

  const notice = document.querySelector("#page-notice");
  const target = document.querySelector("#purchase-order-list");
  let status = "draft";

  document.querySelectorAll("[data-status]").forEach(button => {
    button.addEventListener("click", async () => {
      document.querySelectorAll("[data-status]").forEach(item =>
        item.classList.toggle("is-active", item === button));
      status = button.dataset.status || null;
      await load();
    });
  });

  async function load() {
    try {
      const rows = await PurchaseOrdersService.list(status);
      render(rows);
    } catch (error) {
      setNotice(notice, error.message, "error");
    }
  }

  function render(rows) {
    if (!rows.length) {
      target.innerHTML = `
        <div class="empty-state">
          <h2>No ${status || ""} purchase orders</h2>
          <p>Create a purchase order from the Roaster Orders page.</p>
        </div>`;
      return;
    }

    target.innerHTML = `
      <div class="purchase-order-card-grid">
        ${rows.map(row => `
          <a class="purchase-order-card"
             href="/committee/purchase-order.html?id=${row.id}">
            <div class="purchase-order-card__heading">
              <strong>${escapeHtml(row.po_number)}</strong>
              <span class="status-badge ${statusClass(row.status)}">
                ${escapeHtml(statusLabel(row.status))}
              </span>
            </div>
            <h2>${escapeHtml(row.supplier_name)}</h2>
            <dl>
              <div><dt>Date</dt><dd>${formatDate(row.order_date)}</dd></div>
              <div><dt>Bags</dt><dd>${row.total_bags_ordered}</dd></div>
              <div><dt>Lines</dt><dd>${row.product_lines}</dd></div>
              <div><dt>Cost</dt><dd>${money(row.total_cost)}</dd></div>
            </dl>
          </a>
        `).join("")}
      </div>`;
  }

  await load();
}

function statusLabel(value) {
  return {
    draft: "Draft",
    submitted: "Submitted",
    partially_received: "Receiving",
    received: "Received",
    cancelled: "Cancelled"
  }[value] || value;
}

function statusClass(value) {
  if (value === "draft") return "status-badge--inactive";
  if (value === "received") return "status-badge--active";
  if (value === "cancelled") return "status-badge--danger";
  return "status-badge--info";
}

function formatDate(value) {
  return value ? new Date(`${value}T00:00:00`).toLocaleDateString("en-US") : "—";
}

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(Number(value || 0));
}
