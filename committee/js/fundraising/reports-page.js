import { requirePortalUser } from "../../assets/auth-common.js";
import { renderPortalLayout, escapeHtml } from "../components/layout.js?v=1.9.6";
import { DataGrid } from "../components/data-grid.js";
import { FundraisingService } from "../services/fundraising-service.js";
import { money, setNotice } from "../master-data/shared.js";

const result = await requirePortalUser();
if (result) initialize(result);

async function initialize({ user, profile }) {
  const content = renderPortalLayout({ profile, user, pageTitle: "Reports" });
  content.innerHTML = `
    <div class="breadcrumb">Committee Portal / Reports</div>
    <div class="page-heading">
      <div>
        <h1>Fundraiser Reports</h1>
        <p>Product purchasing, scout balances, customer sales, and treasurer snapshots.</p>
      </div>
    </div>
    <div id="page-notice" class="notice" hidden></div>
    <div class="report-tabs print-hide">
      <button class="portal-button" data-tab="snapshot">Treasurer Snapshot</button>
      <button class="portal-button portal-button--secondary" data-tab="products">Product / Roaster</button>
      <button class="portal-button portal-button--secondary" data-tab="balances">Scout Balances</button>
      <button class="portal-button portal-button--secondary" data-tab="customers">Customer Sales</button>
    </div>
    <section class="panel" id="report-panel">
      <div id="report-grid"></div>
    </section>`;

  const notice = document.querySelector("#page-notice");
  const buttons = [...document.querySelectorAll("[data-tab]")];
  let productRows = [];
  let balanceRows = [];
  let customerRows = [];
  let snapshotRows = [];

  try {
    const [items, balances, orders, snapshotItems] = await Promise.all([
      FundraisingService.productReport(),
      FundraisingService.summary(),
      FundraisingService.customerReport(),
      FundraisingService.treasurerSnapshot()
    ]);

    productRows = aggregateProducts(items);
    balanceRows = balances.map(row => ({
      ...row,
      scout_name: [row.first_name, row.last_name].filter(Boolean).join(" ") || "General Fund"
    }));
    customerRows = aggregateCustomers(orders);
    snapshotRows = aggregateTreasurerSnapshot(snapshotItems, balances);
    show("snapshot");
  } catch (error) {
    setNotice(notice, error.message, "error");
  }

  buttons.forEach(button => {
    button.onclick = () => show(button.dataset.tab);
  });

  function show(tab) {
    buttons.forEach(button => {
      button.className = `portal-button ${button.dataset.tab === tab ? "" : "portal-button--secondary"}`;
    });

    const container = document.querySelector("#report-grid");
    container.innerHTML = "";

    if (tab === "snapshot") {
      renderTreasurerSnapshot(container, snapshotRows);
      return;
    }

    if (tab === "products") {
      new DataGrid({
        container,
        rows: productRows,
        columns: [
          { key: "product_name", label: "Product" },
          { key: "supplier", label: "Supplier / Product" },
          { key: "quantity", label: "Bags" },
          { key: "sales", label: "Sales", render: row => money(row.sales) },
          { key: "credit", label: "Credit", render: row => money(row.credit) }
        ],
        searchFields: ["product_name", "supplier"],
        exportFileName: "friends-323-product-roaster-report.csv"
      });
      return;
    }

    if (tab === "balances") {
      new DataGrid({
        container,
        rows: balanceRows,
        columns: [
          { key: "scout_name", label: "Scout" },
          { key: "bags_sold", label: "Bags" },
          { key: "total_sales", label: "Total Sales", render: row => money(row.total_sales) },
          { key: "total_fundraising_credit", label: "Credit Earned", render: row => money(row.total_fundraising_credit) },
          { key: "paid_to_pack", label: "Paid to Pack", render: row => money(row.paid_to_pack) },
          { key: "available_credit", label: "Available", render: row => money(row.available_credit) }
        ],
        searchFields: ["scout_name"],
        exportFileName: "friends-323-scout-balances.csv"
      });
      return;
    }

    if (tab === "customers") {
      new DataGrid({
        container,
        rows: customerRows,
        columns: [
          { key: "customer_name", label: "Customer" },
          { key: "orders", label: "Orders" },
          { key: "bags", label: "Bags" },
          { key: "sales", label: "Sales", render: row => money(row.sales) }
        ],
        searchFields: ["customer_name"],
        exportFileName: "friends-323-customer-sales.csv"
      });
    }
  }
}

function renderTreasurerSnapshot(container, rows) {
  const activityRows = rows.filter(row =>
    row.is_active !== false && (
      Number(row.bags_sold || 0) !== 0 ||
      Number(row.total_sales || 0) !== 0 ||
      Number(row.total_fundraising_credit || 0) !== 0 ||
      Number(row.paid_to_pack || 0) !== 0 ||
      Number(row.available_credit || 0) !== 0
    )
  );

  const totalBags = sum(activityRows, "bags_sold");
  const totalSales = sum(activityRows, "total_sales");
  const totalCredit = sum(activityRows, "total_fundraising_credit");
  const totalTransferred = sum(activityRows, "paid_to_pack");
  const totalAvailable = sum(activityRows, "available_credit");
  const reportDate = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date());

  container.innerHTML = `
    <div class="treasurer-snapshot-actions print-hide">
      <div>
        <h2>Treasurer Fundraising Snapshot</h2>
        <p>Paid-order sales and fundraising credit earned as of today.</p>
      </div>
      <button class="portal-button" id="print-snapshot" type="button">Print / Save PDF</button>
    </div>

    <div class="treasurer-snapshot-sheet">
      <div class="treasurer-report-header">
        <div>
          <div class="section-eyebrow">Friends of 323</div>
          <h1>Fundraising Credit & Sales Report</h1>
        </div>
        <div class="report-transfer-number">As of ${escapeHtml(reportDate)}</div>
      </div>

      <div class="report-summary-grid snapshot-summary-grid">
        <div><span>Total Sales</span><strong>${money(totalSales)}</strong></div>
        <div><span>Total Credit Earned</span><strong>${money(totalCredit)}</strong></div>
        <div><span>Previously Transferred</span><strong>${money(totalTransferred)}</strong></div>
        <div><span>Available Credit</span><strong>${money(totalAvailable)}</strong></div>
        <div><span>Total Bags Sold</span><strong>${Number(totalBags).toLocaleString("en-US")}</strong></div>
      </div>

      <table class="treasurer-table snapshot-table">
        <thead>
          <tr>
            <th>Scout / Fund</th>
            <th class="amount-column">Bags Sold</th>
            <th class="amount-column">Total Sales</th>
            <th class="amount-column">Credit Earned</th>
            <th class="amount-column">Previously Transferred</th>
            <th class="amount-column">Available Credit</th>
            <th class="register-column">In Register</th>
          </tr>
        </thead>
        <tbody>
          ${activityRows.map(row => `
            <tr>
              <td>${escapeHtml(row.scout_name)}</td>
              <td class="amount-column">${Number(row.bags_sold || 0).toLocaleString("en-US")}</td>
              <td class="amount-column">${money(row.total_sales)}</td>
              <td class="amount-column">${money(row.total_fundraising_credit)}</td>
              <td class="amount-column">${money(row.paid_to_pack)}</td>
              <td class="amount-column">${money(row.available_credit)}</td>
              <td class="register-column"><input class="treasurer-register-check" type="checkbox" aria-label="Payment noted in register for ${escapeHtml(row.scout_name)}"></td>
            </tr>`).join("")}
          <tr class="report-total-row">
            <td>Total</td>
            <td class="amount-column">${Number(totalBags).toLocaleString("en-US")}</td>
            <td class="amount-column">${money(totalSales)}</td>
            <td class="amount-column">${money(totalCredit)}</td>
            <td class="amount-column">${money(totalTransferred)}</td>
            <td class="amount-column">${money(totalAvailable)}</td>
            <td class="register-column"></td>
          </tr>
        </tbody>
      </table>

      <p class="report-footnote">
        This snapshot shows active Scouts only and includes only active orders with a payment status of Paid as of ${escapeHtml(reportDate)}.
        Paid orders count even if delivery has not occurred yet. Unpaid, voided/cancelled, and refunded orders are excluded.
        Previously Transferred shows credit already applied to Pack payments; Available Credit shows the remaining Scout balance.
        The In Register checkbox is for the treasurer to mark when the corresponding amount has been entered in the Pack register; it does not change system data.
      </p>
    </div>`;

  document.querySelector("#print-snapshot")?.addEventListener("click", () => window.print());
}

function aggregateTreasurerSnapshot(items, balances = []) {
  const balanceMap = new Map(balances.map(row => [row.scout_id, row]));
  const map = new Map();

  for (const item of items) {
    const scout = item.scouts || {};
    const key = item.scout_id || "unassigned";
    if (!map.has(key)) {
      const balance = balanceMap.get(item.scout_id) || {};
      map.set(key, {
        scout_id: item.scout_id || null,
        scout_name: scout.is_general_fund
          ? "General Fund"
          : ([scout.first_name, scout.last_name].filter(Boolean).join(" ") || "Unassigned"),
        is_active: scout.is_active !== false,
        bags_sold: 0,
        total_sales: 0,
        total_fundraising_credit: 0,
        paid_to_pack: Number(balance.paid_to_pack || 0),
        available_credit: Number(balance.available_credit || 0)
      });
    }
    const row = map.get(key);
    row.bags_sold += Number(item.quantity || 0);
    row.total_sales += Number(item.line_total || 0);
    row.total_fundraising_credit += Number(item.fundraising_credit_total || 0);
  }

  return [...map.values()]
    .filter(row => row.is_active !== false)
    .sort((a, b) => a.scout_name.localeCompare(b.scout_name));
}

function aggregateProducts(items) {
  const map = new Map();
  for (const item of items) {
    const product = item.products || {};
    const key = product.sku || product.product_name;
    if (!map.has(key)) {
      map.set(key, {
        product_name: `${product.product_name || "Unknown"} · ${product.bag_size || ""}`,
        supplier: [product.supplier_name, product.supplier_product_name].filter(Boolean).join(" / ") || "—",
        quantity: 0,
        sales: 0,
        credit: 0
      });
    }
    const row = map.get(key);
    row.quantity += Number(item.quantity || 0);
    row.sales += Number(item.line_total || 0);
    row.credit += Number(item.fundraising_credit_total || 0);
  }
  return [...map.values()];
}

function aggregateCustomers(orders) {
  const map = new Map();
  for (const order of orders) {
    const customer = order.customers || {};
    const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ") || customer.company_name || "Unknown";
    const key = order.customer_id;
    if (!map.has(key)) map.set(key, { customer_name: name, orders: 0, bags: 0, sales: 0 });
    const row = map.get(key);
    row.orders++;
    for (const item of order.order_items || []) {
      row.bags += Number(item.quantity || 0);
      row.sales += Number(item.line_total || 0);
    }
  }
  return [...map.values()];
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
}
