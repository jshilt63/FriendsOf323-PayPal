import { DashboardService } from "../services/dashboard-service.js?v=1.9.5";
import { ScoutsService } from "../services/scouts-service.js";
import { requirePortalUser } from "../../assets/auth-common.js";
import { renderPortalLayout, escapeHtml } from "../components/layout.js?v=1.9.0";
import { hasMinimumRole } from "../shared/roles.js";
import { emptyState, operationCard, priorityItem, statusPill } from "../components/dashboard-components.js";

const LABELS = {
  payment_status: { unpaid: "Unpaid", partially_paid: "Partially Paid", paid: "Paid", refunded: "Refunded" },
  wholesaler_status: { not_ready: "Not Ready", ready_to_submit: "Ready to Submit", submitted: "Submitted", in_process: "In Process", received: "Received" },
  delivery_status: { not_ready: "Not Ready", ready_for_pickup: "Ready for Pickup", out_for_delivery: "Out for Delivery", delivered: "Delivered" }
};

const result = await requirePortalUser();
if (result) await initialize(result);

async function initialize({ user, profile }) {
  const canOperate = hasMinimumRole(profile.role, "barista");
  const canManage = hasMinimumRole(profile.role, "coffee_bean");
  const content = renderPortalLayout({ profile, user, pageTitle: "Dashboard" });

  content.innerHTML = `
    <div class="dashboard-heading">
      <div>
        <p class="dashboard-kicker">Friends of 323 Coffee Fundraiser</p>
        <h1>${greeting()}, ${escapeHtml(firstName(profile.display_name || user.email))}</h1>
        <p id="dashboard-subtitle">Loading the committee action center…</p>
      </div>
      <div class="dashboard-heading__actions">
        <label class="form-field dashboard-den-filter"><span>Den view</span><select id="dashboard-den-filter"></select></label>
        ${canOperate ? '<a class="portal-button" href="/committee/orders.html?action=new">New Order</a>' : ""}
        ${canManage ? '<a class="portal-button portal-button--secondary" href="/committee/transfers.html?action=new">Record Transfer</a>' : ""}
      </div>
    </div>

    <div id="dashboard-notice" class="notice">Loading dashboard…</div>

    <section class="action-center dashboard-section" aria-labelledby="action-center-title">
      <div class="section-heading">
        <div><p class="section-eyebrow">Action Center</p><h2 id="action-center-title">Today’s Priorities</h2></div>
        <span class="section-meta" id="dashboard-updated"></span>
      </div>
      <div id="priority-list" class="priority-list"></div>
    </section>

    <section class="dashboard-section" aria-labelledby="operations-title">
      <div class="section-heading"><div><p class="section-eyebrow">Operations</p><h2 id="operations-title">Current Work</h2></div></div>
      <div id="operations-grid" class="operations-grid"></div>
    </section>

    <section class="dashboard-content-grid dashboard-section">
      <article class="dashboard-panel dashboard-panel--wide">
        <div class="section-heading">
          <div><p class="section-eyebrow">Orders</p><h2>Recent Orders</h2></div>
          <a class="section-link" href="/committee/orders.html">View all orders →</a>
        </div>
        <div id="recent-orders"></div>
      </article>

      <article class="dashboard-panel">
        <div class="section-heading">
          <div><p class="section-eyebrow">Fundraising</p><h2>Top Scouts</h2></div>
          <a class="section-link" href="/committee/fundraising.html">View summary →</a>
        </div>
        <div id="top-scouts" class="rank-list"></div>
      </article>
    </section>

    <section class="dashboard-content-grid dashboard-section">
      <article class="dashboard-panel">
        <div class="section-heading">
          <div><p class="section-eyebrow">Activity</p><h2>Recent Activity</h2></div>
        </div>
        <div id="recent-activity" class="activity-feed"></div>
      </article>

      <article class="dashboard-panel">
        <div class="section-heading">
          <div><p class="section-eyebrow">Fundraising</p><h2>Recent Pack Transfers</h2></div>
          <a class="section-link" href="/committee/transfers.html">View transfers →</a>
        </div>
        <div id="recent-transfers" class="transfer-list"></div>
      </article>
    </section>

    <section class="dashboard-panel dashboard-section">
      <div class="section-heading"><div><p class="section-eyebrow">Shortcuts</p><h2>Quick Actions</h2></div></div>
      <div class="dashboard-quick-actions">
        ${canOperate ? '<a href="/committee/orders.html?action=new"><strong>New Order</strong><span>Enter a manual coffee order</span></a>' : ""}
        ${canOperate ? '<a href="/committee/customers.html?action=new"><strong>New Customer</strong><span>Add contact information</span></a>' : ""}
        ${canManage ? '<a href="/committee/transfers.html?action=new"><strong>Record Transfer</strong><span>Apply credit to dues or camp</span></a>' : ""}
        ${canManage ? '<a href="/committee/scouts.html?action=new"><strong>Add Scout</strong><span>Update the active roster</span></a>' : ""}
        <a href="/committee/fundraising.html"><strong>Scout Summary</strong><span>Review balances and ledgers</span></a>
        <a href="/committee/reports.html"><strong>Reports</strong><span>Sales, purchasing, and fundraising</span></a>
      </div>
    </section>`;

  const denSelect = document.querySelector("#dashboard-den-filter");
  try {
    const dens = await ScoutsService.listDens();
    denSelect.innerHTML = dashboardDenOptions(profile, dens);
    denSelect.addEventListener("change", loadDashboard);
    await loadDashboard();
  } catch (error) {
    showDashboardError(error);
  }

  async function loadDashboard() {
    try {
      const denId = denSelect.value === "all" ? null : denSelect.value;
      const dashboard = await DashboardService.getDashboard({ includeAudit: canManage, denId });
      renderDashboard(dashboard);
      const notice = document.querySelector("#dashboard-notice");
      notice.hidden = true;
    } catch (error) { showDashboardError(error); }
  }
  function showDashboardError(error) {
    const notice = document.querySelector("#dashboard-notice");
    notice.hidden = false;
    notice.className = "notice notice--error";
    notice.textContent = `Dashboard data could not be loaded: ${error.message}`;
  }
}

function renderDashboard(data) {
  document.querySelector("#dashboard-subtitle").textContent = data.priorities.length
    ? `${data.priorities.length} item${data.priorities.length === 1 ? "" : "s"} currently need committee attention.`
    : "Everything requiring committee attention is currently up to date.";
  document.querySelector("#dashboard-updated").textContent = `Updated ${formatTime(data.generatedAt)}`;

  document.querySelector("#priority-list").innerHTML = data.priorities.length
    ? data.priorities.map(priorityItem).join("")
    : emptyState("Everything looks good. No immediate action is required.");

  const ops = data.operations;
  document.querySelector("#operations-grid").innerHTML = [
    operationCard({
      tone: ops.awaitingPayment.orders ? "warning" : "success",
      eyebrow: "Payments",
      title: ops.awaitingPayment.orders ? "Awaiting Payment" : "Payments Current",
      value: ops.awaitingPayment.orders ? `${ops.awaitingPayment.orders} order${plural(ops.awaitingPayment.orders)}` : "All paid",
      detail: ops.awaitingPayment.orders ? `${money(ops.awaitingPayment.amount)} outstanding` : "No outstanding payments",
      secondary: ops.awaitingPayment.oldOrders ? `${ops.awaitingPayment.oldOrders} at least 7 days old` : "",
      href: "/committee/orders.html?workflow=payment",
      actionLabel: "Review payments"
    }),
    operationCard({
      tone: ops.readyForRoaster.orders ? "info" : "success",
      eyebrow: "Roaster",
      title: ops.readyForRoaster.orders ? "Ready to Order" : "Roaster Queue Clear",
      value: ops.readyForRoaster.orders ? `${ops.readyForRoaster.bags} bag${plural(ops.readyForRoaster.bags)}` : "Nothing waiting",
      detail: ops.readyForRoaster.orders ? `${ops.readyForRoaster.orders} customer order${plural(ops.readyForRoaster.orders)}` : "No purchase order needed",
      secondary: ops.readyForRoaster.suppliers.slice(0, 2).map(row => `<span>${escapeHtml(row.supplier)}: <strong>${row.bags}</strong></span>`).join(""),
      href: "/committee/ready-to-order.html",
      actionLabel: "Open ready-to-order list"
    }),
    operationCard({
      tone: ops.readyForPickup.orders ? "info" : "success",
      eyebrow: "Pickup",
      title: ops.readyForPickup.orders ? "Ready for Pickup" : "Pickup Queue Clear",
      value: ops.readyForPickup.orders ? `${ops.readyForPickup.orders} order${plural(ops.readyForPickup.orders)}` : "All delivered",
      detail: ops.readyForPickup.orders ? `${ops.readyForPickup.bags} bag${plural(ops.readyForPickup.bags)} waiting` : "No coffee waiting for customers",
      href: "/committee/orders.html?workflow=pickup",
      actionLabel: "Open pickup list"
    }),
    operationCard({
      tone: ops.pendingDelivery.orders ? "neutral" : "success",
      eyebrow: "Fulfillment",
      title: ops.pendingDelivery.orders ? "Not Delivered" : "Everything Delivered",
      value: ops.pendingDelivery.orders ? `${ops.pendingDelivery.orders} order${plural(ops.pendingDelivery.orders)}` : "Complete",
      detail: ops.pendingDelivery.orders ? `${money(ops.pendingDelivery.amount)} in active orders` : "No active deliveries pending",
      href: "/committee/orders.html",
      actionLabel: "Review fulfillment"
    }),
    operationCard({
      tone: "fundraising",
      eyebrow: "Scout Credit",
      title: "Available Fundraising",
      value: money(ops.fundraising.available),
      detail: `${ops.fundraising.scouts} scout${plural(ops.fundraising.scouts)} with sales`,
      href: "/committee/fundraising.html",
      actionLabel: "View scout summary"
    }),
    operationCard({
      tone: "sales",
      eyebrow: ops.monthlySales.monthLabel,
      title: "Monthly Sales",
      value: money(ops.monthlySales.amount),
      detail: `${ops.monthlySales.bags} bag${plural(ops.monthlySales.bags)} sold this month`,
      href: "/committee/reports.html",
      actionLabel: "Open sales reports"
    })
  ].join("");

  renderRecentOrders(data.recentOrders);
  renderTopScouts(data.topScouts);
  renderActivity(data.activity);
  renderTransfers(data.recentTransfers);
}

function renderRecentOrders(rows) {
  const target = document.querySelector("#recent-orders");
  if (!rows.length) { target.innerHTML = emptyState("No active orders have been entered yet."); return; }
  target.innerHTML = `<div class="dashboard-table-wrap"><table class="dashboard-table">
    <thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Total</th><th>Payment</th><th>Delivery</th></tr></thead>
    <tbody>${rows.map(order => `<tr data-order-link="${order.id}">
      <td><a href="/committee/orders.html?order=${order.id}">#${order.order_number}</a>${order.ecwid_order_number ? `<small>Ecwid ${escapeHtml(order.ecwid_order_number)}</small>` : ""}</td>
      <td><strong>${escapeHtml(order.customer_name)}</strong>${order.scout_names.length ? `<small>${escapeHtml(order.scout_names.join(", "))}</small>` : ""}</td>
      <td>${formatDate(order.order_date)}</td>
      <td><strong>${money(order.total)}</strong></td>
      <td>${statusPill(order.payment_status, LABELS.payment_status[order.payment_status])}</td>
      <td>${statusPill(order.delivery_status, LABELS.delivery_status[order.delivery_status])}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

function renderTopScouts(rows) {
  const target = document.querySelector("#top-scouts");
  if (!rows.length) { target.innerHTML = emptyState("No scout sales have been recorded yet."); return; }
  target.innerHTML = rows.map((scout, index) => `
    <a class="rank-item" href="/committee/scout-ledger.html?scout=${scout.scout_id}">
      <span class="rank-item__number">${index + 1}</span>
      <span class="rank-item__name"><strong>${escapeHtml(scout.scout_name)}</strong><small>${Number(scout.bags_sold || 0)} bag${plural(scout.bags_sold)} sold</small></span>
      <span class="rank-item__amount">${money(scout.available_credit)}</span>
    </a>`).join("");
}

function renderActivity(rows) {
  const target = document.querySelector("#recent-activity");
  if (!rows.length) { target.innerHTML = emptyState("No recent portal activity was found."); return; }
  target.innerHTML = rows.map(row => `
    <div class="activity-item">
      <span class="activity-item__dot" aria-hidden="true"></span>
      <div><strong>${escapeHtml(row.title)}</strong>${row.detail ? `<p>${escapeHtml(row.detail)}</p>` : ""}<small>${escapeHtml(row.actor)} · ${relativeTime(row.changed_at)}</small></div>
    </div>`).join("");
}

function renderTransfers(rows) {
  const target = document.querySelector("#recent-transfers");
  if (!rows.length) { target.innerHTML = emptyState("No pack transfers or adjustments have been recorded."); return; }
  target.innerHTML = rows.slice(0, 6).map(row => `
    <a class="transfer-item" href="/committee/scout-ledger.html?scout=${row.scout_id}">
      <span><strong>${escapeHtml(row.scout_name)}</strong><small>${escapeHtml(row.purpose || transactionLabel(row.transaction_type))} · ${formatDate(row.transaction_date)}</small></span>
      <span class="transfer-item__amount">${row.transaction_type === "transfer_to_pack" || row.transaction_type === "adjustment_debit" ? "−" : "+"}${money(row.amount)}</span>
    </a>`).join("");
}

function greeting() { const hour = new Date().getHours(); return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"; }
function firstName(value) { return String(value || "there").trim().split(/[\s@]/)[0] || "there"; }
function transactionLabel(value) { return ({ transfer_to_pack: "Paid to Pack", opening_balance: "Opening Balance", adjustment_credit: "Credit Adjustment", adjustment_debit: "Debit Adjustment" })[value] || "Ledger Entry"; }
function money(value) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value || 0)); }
function formatDate(value) { return value ? new Date(`${value}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"; }
function formatTime(value) { return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }
function relativeTime(value) { const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return "just now"; const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`; const days = Math.floor(hours / 24); return `${days}d ago`; }
function plural(value) { return Number(value) === 1 ? "" : "s"; }

function dashboardDenOptions(profile, dens) {
  if (profile.role === "barista" && profile.den_id) {
    const den = dens.find(row => row.id === profile.den_id);
    const label = den ? `My Den — Den ${den.den_number} · ${den.current_rank_working_toward}` : "My Den";
    return `<option value="all">All Scouts</option><option value="${profile.den_id}">${escapeHtml(label)}</option>`;
  }
  return '<option value="all">All Dens</option>' + dens.map(den =>
    `<option value="${den.id}">Den ${den.den_number} · ${escapeHtml(den.current_rank_working_toward)}</option>`
  ).join('');
}
