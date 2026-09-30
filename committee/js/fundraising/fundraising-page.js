import { requirePortalUser } from "../../assets/auth-common.js";
import { renderPortalLayout, escapeHtml } from "../components/layout.js?v=1.9.0";
import { DataGrid } from "../components/data-grid.js";
import { FundraisingService } from "../services/fundraising-service.js";
import { money, setNotice } from "../master-data/shared.js";

const result = await requirePortalUser();
if (result) initialize(result);

async function initialize({ user, profile }) {
  const content = renderPortalLayout({ profile, user, pageTitle: "Fundraising" });

  content.innerHTML = `
    <div class="breadcrumb">Committee Portal / Fundraising</div>

    <div class="page-heading">
      <div>
        <h1>Scout Fundraising Summary</h1>
        <p>Sales, credit earned, transfers to the pack, and currently available credit.</p>
      </div>
      <a class="portal-button portal-button--secondary" href="/committee/transfers.html">
        View Transfers
      </a>
    </div>

    <div id="page-notice" class="notice" hidden></div>

    <section class="fundraising-overview" aria-label="Fundraising totals">
      <article class="summary-stat">
        <span class="summary-stat__label">Scouts Shown</span>
        <strong id="scouts-shown">0</strong>
        <small id="view-description">Scouts with sales</small>
      </article>

      <article class="summary-stat">
        <span class="summary-stat__label">Bags Sold</span>
        <strong id="bags-sold">0</strong>
        <small>For the selected view</small>
      </article>

      <article class="summary-stat">
        <span class="summary-stat__label">Credit Earned</span>
        <strong id="earned">$0.00</strong>
        <small>From completed order lines</small>
      </article>

      <article class="summary-stat">
        <span class="summary-stat__label">Paid to Pack</span>
        <strong id="paid">$0.00</strong>
        <small>Dues, camp, and other transfers</small>
      </article>

      <article class="summary-stat summary-stat--featured">
        <span class="summary-stat__label">Available Credit</span>
        <strong id="available">$0.00</strong>
        <small>Current combined balance</small>
      </article>
    </section>

    <section class="panel fundraising-summary-panel">
      <div class="summary-panel-heading">
        <div>
          <h2>Scout Balances</h2>
          <p id="summary-help">Showing only scouts who have recorded sales.</p>
        </div>
      </div>
      <div id="summary-grid"></div>
    </section>
  `;

  const notice = document.querySelector("#page-notice");

  const grid = new DataGrid({
    container: "#summary-grid",
    columns: [
      {
        key: "scout_name",
        label: "Scout",
        render: row => `
          <a class="scout-summary-link"
             href="/committee/scout-ledger.html?scout=${row.scout_id}">
            <strong>${escapeHtml(row.scout_name)}</strong>
          </a>
          ${row.is_general_fund
            ? '<div class="cell-note">Pack General Fund</div>'
            : row.unit
              ? `<div class="cell-note">${escapeHtml(row.unit)}</div>`
              : ""}
          ${!row.is_general_fund ? `<div class="cell-note">${escapeHtml(row.den_display)}</div>` : ""}
        `
      },
      {
        key: "bags_sold",
        label: "Bags",
        render: row => `<strong>${Number(row.bags_sold || 0).toLocaleString()}</strong>`
      },
      {
        key: "total_sales",
        label: "Sales",
        render: row => money(row.total_sales),
        exportValue: row => Number(row.total_sales || 0).toFixed(2)
      },
      {
        key: "total_fundraising_credit",
        label: "Credit Earned",
        render: row => money(row.total_fundraising_credit),
        exportValue: row => Number(row.total_fundraising_credit || 0).toFixed(2)
      },
      {
        key: "paid_to_pack",
        label: "Paid to Pack",
        render: row => money(row.paid_to_pack),
        exportValue: row => Number(row.paid_to_pack || 0).toFixed(2)
      },
      {
        key: "available_credit",
        label: "Available",
        render: row => `
          <span class="balance-badge ${Number(row.available_credit || 0) > 0
            ? "balance-badge--positive"
            : Number(row.available_credit || 0) < 0
              ? "balance-badge--negative"
              : "balance-badge--zero"}">
            ${money(row.available_credit)}
          </span>
        `,
        exportValue: row => Number(row.available_credit || 0).toFixed(2)
      },
      {
        key: "is_active",
        label: "Roster Status",
        render: row => `
          <span class="status-badge ${row.is_active
            ? "status-badge--active"
            : "status-badge--inactive"}">
            ${row.is_active ? "Active" : "Inactive"}
          </span>
        `
      }
    ],
    searchFields: ["scout_name", "unit", "den_display"],
    exportFileName: "friends-323-scout-summary.csv",
    pageSize: 15,
    emptyMessage: "No scouts match the selected fundraising view.",
    filters: [
      {
        key: "den",
        label: "Den",
        type: "select",
        defaultValue: "all",
        options: denFilterOptions(profile),
        predicate: (row, value) => value === "all" || row.den_id === value
      },
      {
        key: "activity",
        label: "Show",
        type: "select",
        defaultValue: "sales",
        options: [
          { value: "sales", label: "Scouts with Sales" },
          { value: "activity", label: "Any Fundraising Activity" },
          { value: "active", label: "All Active Scouts" },
          { value: "all", label: "All Scouts" }
        ],
        predicate: (row, value) => {
          const bags = Number(row.bags_sold || 0);
          const earned = Number(row.total_fundraising_credit || 0);
          const paid = Number(row.paid_to_pack || 0);
          const available = Number(row.available_credit || 0);

          if (value === "sales") return bags > 0;
          if (value === "activity") {
            return bags > 0 || earned !== 0 || paid !== 0 || available !== 0;
          }
          if (value === "active") return row.is_active;
          return true;
        }
      }
    ]
  });

  grid.sortKey = "available_credit";
  grid.sortDirection = "desc";
  grid.searchInput.placeholder = "Search scout or unit";

  const activitySelect = document.querySelector('[data-filter="activity"]');
  if (activitySelect) activitySelect.value = "sales";

  document.querySelector("#summary-grid").addEventListener("datagrid:render", updateOverview);

  try {
    const data = await FundraisingService.summary();
    const rows = data.map(row => ({
      ...row,
      scout_name: [row.first_name, row.last_name].filter(Boolean).join(" "),
      den_id: row.scouts?.den_id || null,
      den_display: row.scouts?.dens?.den_number
        ? `Den ${row.scouts.dens.den_number} · ${row.scouts.dens.current_rank_working_toward}`
        : "No den assigned"
    }));

    grid.setRows(rows);
    populateFundraisingDenFilter(grid, rows, profile);
  } catch (error) {
    setNotice(notice, error.message, "error");
  }

  function updateOverview() {
    const rows = grid.getFilteredRows();
    const view = grid.filterValues.activity || "sales";

    document.querySelector("#scouts-shown").textContent =
      rows.length.toLocaleString();

    document.querySelector("#bags-sold").textContent =
      sum(rows, "bags_sold").toLocaleString();

    document.querySelector("#earned").textContent =
      money(sum(rows, "total_fundraising_credit"));

    document.querySelector("#paid").textContent =
      money(sum(rows, "paid_to_pack"));

    document.querySelector("#available").textContent =
      money(sum(rows, "available_credit"));

    const descriptions = {
      sales: {
        card: "Scouts with sales",
        help: "Showing only scouts who have recorded one or more bag sales."
      },
      activity: {
        card: "Scouts with activity",
        help: "Showing scouts with sales, transfers, adjustments, or a non-zero balance."
      },
      active: {
        card: "All active scouts",
        help: "Showing every active scout, including scouts who have not recorded sales."
      },
      all: {
        card: "All roster records",
        help: "Showing active and inactive scouts, including those without fundraising activity."
      }
    };

    const description = descriptions[view] || descriptions.sales;
    document.querySelector("#view-description").textContent = description.card;
    document.querySelector("#summary-help").textContent = description.help;
  }
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
}

function denFilterOptions(profile) {
  if (profile.role === "barista" && profile.den_id) return [
    { value: "all", label: "All Scouts" },
    { value: profile.den_id, label: "My Den" }
  ];
  return [{ value: "all", label: "All Dens" }];
}
function populateFundraisingDenFilter(grid, rows, profile) {
  const select = grid.container.querySelector('[data-filter="den"]');
  if (!select || profile.role === "barista") return;
  const dens = new Map(rows.filter(r => r.den_id).map(r => [r.den_id, r.den_display]));
  select.innerHTML = '<option value="all">All Dens</option>' + [...dens.entries()]
    .sort((a,b)=>a[1].localeCompare(b[1],undefined,{numeric:true}))
    .map(([id,label])=>`<option value="${id}">${escapeHtml(label)}</option>`).join('');
}
