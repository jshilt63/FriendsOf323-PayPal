import { escapeHtml } from "./layout.js";

export class DataGrid {
  constructor(options) {
    const {
      container,
      columns,
      rows = options.data || [],
      searchFields = options.searchKeys || [],
      pageSize = 10,
      emptyMessage = "No records found.",
      exportFileName = options.csvFilename || "export.csv",
      rowActions = null,
      filters = []
    } = options;
    this.container = typeof container === "string" ? document.querySelector(container) : container;
    this.columns = columns;
    this.rows = rows;
    this.searchFields = searchFields;
    this.pageSize = pageSize;
    this.emptyMessage = emptyMessage;
    this.exportFileName = exportFileName;
    this.rowActions = rowActions;
    this.filters = filters;
    this.query = "";
    this.sortKey = columns.find(column => column.sortable !== false)?.key || null;
    this.sortDirection = "asc";
    this.page = 1;
    this.filterValues = Object.fromEntries(filters.map(filter => [filter.key, filter.defaultValue ?? ""]));
    this.renderShell();
    this.bind();
    this.render();
  }

  renderShell() {
    this.container.innerHTML = `
      <div class="data-grid-toolbar">
        <label class="search-field data-grid-search">
          <span class="sr-only">Search records</span>
          <input type="search" data-grid-search placeholder="Search">
        </label>
        <div class="data-grid-filters">
          ${this.filters.map(filter => filter.type === "toggle-button"
            ? `<button type="button" class="portal-button ${filter.defaultValue ? escapeHtml(filter.activeClass || "portal-button--secondary") : escapeHtml(filter.inactiveClass || "portal-button--secondary")}" data-filter="${escapeHtml(filter.key)}" aria-pressed="${filter.defaultValue ? "true" : "false"}">${escapeHtml(filter.defaultValue ? (filter.activeLabel || filter.label) : (filter.inactiveLabel || filter.label))}</button>`
            : filter.type === "checkbox"
              ? `<label class="filter-field"><input type="checkbox" data-filter="${escapeHtml(filter.key)}" ${filter.defaultValue ? "checked" : ""}> ${escapeHtml(filter.label)}</label>`
              : `<label class="filter-select"><span>${escapeHtml(filter.label)}</span><select data-filter="${escapeHtml(filter.key)}">${filter.options.map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("")}</select></label>`).join("")}
          <button type="button" class="portal-button portal-button--secondary" data-grid-export>Export CSV</button>
        </div>
      </div>
      <div class="table-wrap"><table class="data-table data-grid-table"><thead><tr></tr></thead><tbody></tbody></table></div>
      <div class="data-grid-footer"><span data-grid-count></span><div class="data-grid-pagination"><button type="button" class="table-action" data-grid-prev>Previous</button><span data-grid-page></span><button type="button" class="table-action" data-grid-next>Next</button></div></div>`;
    this.searchInput = this.container.querySelector("[data-grid-search]");
    this.thead = this.container.querySelector("thead tr");
    this.tbody = this.container.querySelector("tbody");
    this.count = this.container.querySelector("[data-grid-count]");
    this.pageLabel = this.container.querySelector("[data-grid-page]");
    this.prev = this.container.querySelector("[data-grid-prev]");
    this.next = this.container.querySelector("[data-grid-next]");
  }

  bind() {
    this.searchInput.addEventListener("input", () => { this.query = this.searchInput.value.trim().toLowerCase(); this.page = 1; this.render(); });
    this.container.querySelector("[data-grid-export]").addEventListener("click", () => this.exportCsv());
    this.prev.addEventListener("click", () => { if (this.page > 1) { this.page--; this.render(); } });
    this.next.addEventListener("click", () => { if (this.page < this.totalPages) { this.page++; this.render(); } });
    this.container.querySelectorAll("[data-filter]").forEach(control => {
      const filter = this.filters.find(item => item.key === control.dataset.filter);
      if (control.tagName === "BUTTON" && filter?.type === "toggle-button") {
        control.addEventListener("click", () => {
          const nextValue = !Boolean(this.filterValues[filter.key]);
          this.filterValues[filter.key] = nextValue;
          control.setAttribute("aria-pressed", nextValue ? "true" : "false");
          control.textContent = nextValue ? (filter.activeLabel || filter.label) : (filter.inactiveLabel || filter.label);
          control.className = `portal-button ${nextValue ? (filter.activeClass || "portal-button--secondary") : (filter.inactiveClass || "portal-button--secondary")}`;
          this.page = 1;
          this.render();
        });
        return;
      }
      control.addEventListener("change", () => {
        this.filterValues[control.dataset.filter] = control.type === "checkbox" ? control.checked : control.value;
        this.page = 1; this.render();
      });
    });
  }

  setRows(rows) { this.rows = rows || []; this.page = 1; this.render(); }
  setData(rows) { this.setRows(rows); }
  getRows() { return [...this.rows]; }
  refresh() { this.render(); }

  getFilteredRows() {
    let result = this.rows.filter(row => {
      if (this.query) {
        const values = this.searchFields.length ? this.searchFields.map(field => valueByPath(row, field)) : Object.values(row);
        if (!values.some(value => String(value ?? "").toLowerCase().includes(this.query))) return false;
      }
      return this.filters.every(filter => !filter.predicate || filter.predicate(row, this.filterValues[filter.key]));
    });
    if (this.sortKey) {
      const column = this.columns.find(item => item.key === this.sortKey);
      result = [...result].sort((a,b) => compareValues(column?.sortValue ? column.sortValue(a) : valueByPath(a,this.sortKey), column?.sortValue ? column.sortValue(b) : valueByPath(b,this.sortKey), this.sortDirection));
    }
    return result;
  }

  render() {
    const actionColumn = this.rowActions ? [{key:"__actions",label:"Actions",sortable:false}] : [];
    const visibleColumns = [...this.columns, ...actionColumn];
    this.thead.innerHTML = visibleColumns.map(column => `<th>${column.sortable === false ? escapeHtml(column.label) : `<button type="button" class="sort-button" data-sort="${escapeHtml(column.key)}">${escapeHtml(column.label)}${this.sortKey===column.key ? (this.sortDirection==="asc" ? " ▲" : " ▼") : ""}</button>`}</th>`).join("");
    this.thead.querySelectorAll("[data-sort]").forEach(button => button.addEventListener("click", () => {
      if (this.sortKey === button.dataset.sort) this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
      else { this.sortKey = button.dataset.sort; this.sortDirection = "asc"; }
      this.render();
    }));

    const filtered = this.getFilteredRows();
    this.totalPages = Math.max(1, Math.ceil(filtered.length / this.pageSize));
    if (this.page > this.totalPages) this.page = this.totalPages;
    const start = (this.page - 1) * this.pageSize;
    const pageRows = filtered.slice(start, start + this.pageSize);
    this.tbody.innerHTML = pageRows.length ? pageRows.map(row => `<tr>${this.columns.map(column => `<td>${column.render ? column.render(row) : escapeHtml(valueByPath(row,column.key) ?? "—")}</td>`).join("")}${this.rowActions ? `<td class="actions-cell">${this.rowActions(row)}</td>` : ""}</tr>`).join("") : `<tr><td colspan="${visibleColumns.length}" class="empty-state">${escapeHtml(this.emptyMessage)}</td></tr>`;
    this.count.textContent = `${filtered.length} record${filtered.length === 1 ? "" : "s"}`;
    this.pageLabel.textContent = `Page ${this.page} of ${this.totalPages}`;
    this.prev.disabled = this.page <= 1;
    this.next.disabled = this.page >= this.totalPages;
    this.container.dispatchEvent(new CustomEvent("datagrid:render", { detail: { rows: pageRows } }));
  }

  exportCsv() {
    const rows = this.getFilteredRows();
    const exportColumns = this.columns.filter(column => column.exportable !== false);
    const csv = [exportColumns.map(column => csvCell(column.label)).join(","), ...rows.map(row => exportColumns.map(column => csvCell(column.exportValue ? column.exportValue(row) : valueByPath(row,column.key))).join(","))].join("\r\n");
    const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = this.exportFileName; link.click(); URL.revokeObjectURL(link.href);
  }
}

function valueByPath(object,path) { return String(path).split(".").reduce((value,key) => value?.[key],object); }
function compareValues(a,b,direction) { const multiplier=direction==="asc"?1:-1; const an=Number(a), bn=Number(b); if(a!==""&&b!==""&&!Number.isNaN(an)&&!Number.isNaN(bn)) return (an-bn)*multiplier; return String(a??"").localeCompare(String(b??""),undefined,{numeric:true,sensitivity:"base"})*multiplier; }
function csvCell(value) { const text=String(value??""); return `"${text.replaceAll('"','""')}"`; }
