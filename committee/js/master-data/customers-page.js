import { CustomersService } from "../services/customers-service.js";
import { requirePortalUser } from "../../assets/auth-common.js";
import { renderPortalLayout, escapeHtml } from "../components/layout.js?v=1.9.0";
import { DataGrid } from "../components/data-grid.js";
import { hasMinimumRole } from "../shared/roles.js";
import {
  clearNotice, closeDialog, normalizeNullable, openDialog,
  setFormBusy, setNotice, text
} from "./shared.js";


function formatPhoneNumber(value) {
  const raw = String(value || "").trim();
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  if (!digits) return "";
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)})${digits.slice(3)}`;
  return `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function normalizePhoneNumber(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.slice(0, 10);
}

const result = await requirePortalUser();
if (result) initialize(result);

async function initialize({ user, profile }) {
  const canManage = hasMinimumRole(profile.role, "coffee_bean");
  const params = new URLSearchParams(window.location.search);
  const returnToOrders = params.get("return") === "orders";
  const content = renderPortalLayout({ profile, user, pageTitle: "Customers" });

  content.innerHTML = `
    <div class="breadcrumb">Committee Portal / Customers</div>
    <div class="page-heading">
      <div><h1>Customers</h1><p>Customer contact information and order relationships.</p></div>
      ${canManage ? '<button class="portal-button" id="add-customer">Add Customer</button>' : ""}
    </div>
    <div id="page-notice" class="notice" hidden></div>
    <section class="panel"><div id="customers-grid"></div></section>
    ${canManage ? dialogHtml() : ""}
  `;

  let rows = [];
  const notice = document.querySelector("#page-notice");
  const grid = new DataGrid({
    container: "#customers-grid",
    columns: [
      { key: "display_name", label: "Customer", render: row => `<strong>${escapeHtml(row.display_name)}</strong>${row.company_name && row.display_name !== row.company_name ? `<div class="cell-note">${escapeHtml(row.company_name)}</div>` : ""}` },
      { key: "email", label: "Email", render: row => row.email ? `<a href="mailto:${escapeHtml(row.email)}">${escapeHtml(row.email)}</a>` : "—" },
      { key: "phone", label: "Phone", render: row => escapeHtml(formatPhoneNumber(row.phone) || "—") },
      { key: "location", label: "Location", render: row => escapeHtml(text(row.location)) }
    ],
    searchFields: ["display_name", "company_name", "email", "phone", "location"],
    exportFileName: "friends-323-customers.csv",
    rowActions: canManage ? row => `<button class="table-action" data-edit="${row.id}">Edit</button>` : null
  });

  grid.container.addEventListener("datagrid:render", bind);

  async function load() {
    let data;
    try {
      data = await CustomersService.list();
    } catch (error) {
      return setNotice(notice, error.message, "error");
    }
    rows = (data || []).map(row => ({
      ...row,
      display_name: [row.first_name, row.last_name].filter(Boolean).join(" ") || row.company_name || "Unnamed Customer",
      location: [row.city, row.state, row.postal_code].filter(Boolean).join(", ")
    }));
    grid.setRows(rows);
  }

  let editCustomer = null;

  function bind() {
    grid.container.querySelectorAll("[data-edit]").forEach(button => {
      button.onclick = () => editCustomer?.(button.dataset.edit);
    });
  }

  if (canManage) {
    const dialog = document.querySelector("#customer-dialog");
    const form = document.querySelector("#customer-form");
    const formNotice = document.querySelector("#customer-form-notice");
    const phoneInput = form.elements.phone;
    phoneInput?.addEventListener("input", () => {
      phoneInput.value = formatPhoneNumber(phoneInput.value);
    });
    const fields = [
      "first_name", "last_name", "company_name", "email", "phone",
      "address_line_1", "address_line_2", "city", "state", "postal_code", "notes"
    ];

    document.querySelector("#add-customer").onclick = () => {
      form.reset();
      form.elements.id.value = "";
      clearNotice(formNotice);
      openDialog(dialog);
    };
    dialog.querySelectorAll("[data-close]").forEach(button => {
      button.onclick = () => closeDialog(dialog);
    });

    editCustomer = id => {
      const row = rows.find(item => item.id === id);
      if (!row) return;
      form.elements.id.value = id;
      fields.forEach(key => form.elements[key].value = key === "phone" ? formatPhoneNumber(row[key]) : (row[key] || ""));
      clearNotice(formNotice);
      openDialog(dialog);
    };

    form.onsubmit = async event => {
      event.preventDefault();
      setFormBusy(form, true);
      const fd = new FormData(form);
      const id = fd.get("id");
      const payload = Object.fromEntries(fields.map(key => [key, normalizeNullable(fd.get(key))]));
      payload.phone = normalizePhoneNumber(payload.phone) || null;
      payload.updated_by = user.id;
      if (!id) payload.created_by = user.id;

      let savedCustomer;
      try {
        savedCustomer = await CustomersService.save(id, payload);
      } catch (error) {
        setFormBusy(form, false);
        return setNotice(formNotice, error.message, "error");
      }

      setFormBusy(form, false);

      if (!id && returnToOrders) {
        window.location.href = `/committee/orders.html?action=resume&customer_id=${encodeURIComponent(savedCustomer.id)}`;
        return;
      }

      closeDialog(dialog);
      setNotice(notice, id ? "Customer updated." : "Customer added.", "success");
      await load();
    };
  }

  await load();
  if (params.get("action") === "new" && canManage) {
    document.querySelector("#add-customer")?.click();
  }
}

function dialogHtml() {
  return `<dialog class="portal-dialog portal-dialog--wide" id="customer-dialog"><form method="post" class="dialog-card" id="customer-form"><div class="dialog-header"><h2>Customer</h2><button type="button" class="icon-button" data-close>×</button></div><input type="hidden" name="id"><div class="form-grid"><label class="form-field"><span>First name</span><input name="first_name"></label><label class="form-field"><span>Last name</span><input name="last_name"></label><label class="form-field form-field--full"><span>Company</span><input name="company_name"></label><label class="form-field"><span>Email</span><input name="email" type="email"></label><label class="form-field"><span>Phone</span><input name="phone" type="tel" inputmode="numeric" maxlength="13" placeholder="(816)555-1234"></label><label class="form-field form-field--full"><span>Address line 1</span><input name="address_line_1"></label><label class="form-field form-field--full"><span>Address line 2</span><input name="address_line_2"></label><label class="form-field"><span>City</span><input name="city"></label><label class="form-field"><span>State</span><input name="state" maxlength="2"></label><label class="form-field"><span>ZIP</span><input name="postal_code"></label><label class="form-field form-field--full"><span>Notes</span><textarea name="notes"></textarea></label></div><div id="customer-form-notice" class="notice" hidden></div><div class="dialog-actions"><button type="button" class="portal-button portal-button--secondary" data-close>Cancel</button><button type="submit" class="portal-button">Save Customer</button></div></form></dialog>`;
}
