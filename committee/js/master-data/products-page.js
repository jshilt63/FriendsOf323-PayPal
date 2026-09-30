import { ProductsService } from "../services/products-service.js";
import { requirePortalUser } from "../../assets/auth-common.js";
import { renderPortalLayout, escapeHtml } from "../components/layout.js?v=1.9.6";
import { DataGrid } from "../components/data-grid.js";
import { hasMinimumRole } from "../shared/roles.js";
import {
  clearNotice,
  closeDialog,
  money,
  normalizeNullable,
  openDialog,
  setFormBusy,
  setNotice
} from "./shared.js";

const result = await requirePortalUser();
if (result) await initialize(result);

async function initialize({ user, profile }) {
  const canManage = hasMinimumRole(profile.role, "coffee_bean");
  const content = renderPortalLayout({ profile, user, pageTitle: "Products" });

  content.innerHTML = `
    <div class="breadcrumb">Committee Portal / Products</div>
    <div class="page-heading">
      <div>
        <h1>Products and Pricing</h1>
        <p>Maintain product, supplier, price, and fundraising-credit data.</p>
      </div>
      ${canManage ? '<button class="portal-button" id="add-product" type="button">Add Product</button>' : ""}
    </div>
    <div id="page-notice" class="notice" hidden></div>
    <section class="panel"><div id="products-grid"></div></section>
    ${canManage ? dialogHtml() : ""}
  `;

  const notice = document.querySelector("#page-notice");
  let rows = [];

  const grid = new DataGrid({
    container: "#products-grid",
    columns: [
      {
        key: "product_name",
        label: "Product",
        render: row => `
          <strong>${escapeHtml(row.product_name)}</strong>
          <div class="cell-note">${escapeHtml(row.sku)} · ${escapeHtml(row.bag_size)}</div>
        `
      },
      {
        key: "supplier_name",
        label: "Supplier",
        render: row => `
          ${escapeHtml(row.supplier_name || "—")}
          ${row.supplier_product_name
            ? `<div class="cell-note">${escapeHtml(row.supplier_product_name)}</div>`
            : ""}
        `
      },
      { key: "cost", label: "Cost", render: row => money(row.cost) },
      { key: "sale_price", label: "Sale Price", render: row => money(row.sale_price) },
      {
        key: "fundraising_credit_per_unit",
        label: "Credit",
        render: row => money(row.fundraising_credit_per_unit)
      },
      {
        key: "is_active",
        label: "Status",
        render: row => `
          <span class="status-badge ${row.is_active ? "status-badge--active" : "status-badge--inactive"}">
            ${row.is_active ? "Active" : "Inactive"}
          </span>
        `,
        exportValue: row => row.is_active ? "Active" : "Inactive"
      }
    ],
    searchFields: [
      "product_name",
      "sku",
      "bag_size",
      "supplier_name",
      "supplier_product_name"
    ],
    exportFileName: "friends-323-products.csv",
    filters: [
      {
        key: "inactive",
        label: "Show inactive",
        type: "checkbox",
        defaultValue: false,
        predicate: (row, value) => value || row.is_active
      }
    ],
    rowActions: canManage
      ? row => `<button class="table-action" type="button" data-edit-product="${row.id}">Edit</button>`
      : null
  });

  let dialog = null;
  let form = null;
  let formNotice = null;

  if (canManage) {
    dialog = document.querySelector("#product-dialog");
    form = document.querySelector("#product-form");
    formNotice = document.querySelector("#product-form-notice");

    document.querySelector("#add-product").addEventListener("click", openNewProduct);
    dialog.querySelectorAll("[data-close]").forEach(button => {
      button.addEventListener("click", () => closeDialog(dialog));
    });
    form.addEventListener("submit", saveProduct);
  }

  grid.container.addEventListener("click", event => {
    const button = event.target.closest("[data-edit-product]");
    if (!button || !canManage) return;
    openEditProduct(button.dataset.editProduct);
  });

  async function load() {
    try {
      rows = await ProductsService.list();
      grid.setRows(rows || []);
    } catch (error) {
      setNotice(notice, error.message, "error");
    }
  }

  function openNewProduct() {
    form.reset();
    form.elements.id.value = "";
    form.elements.is_active.checked = true;
    document.querySelector("#product-dialog-title").textContent = "Add Product";
    clearNotice(formNotice);
    openDialog(dialog);
  }

  function openEditProduct(id) {
    const product = rows.find(row => row.id === id);
    if (!product) {
      setNotice(notice, "The selected product could not be found.", "error");
      return;
    }

    form.elements.id.value = product.id;
    form.elements.sku.value = product.sku || "";
    form.elements.product_name.value = product.product_name || "";
    form.elements.supplier_name.value = product.supplier_name || "";
    form.elements.supplier_product_name.value = product.supplier_product_name || "";
    form.elements.bag_size.value = product.bag_size || "other";
    form.elements.cost.value = product.cost ?? "";
    form.elements.sale_price.value = product.sale_price ?? "";
    form.elements.fundraising_credit_per_unit.value = product.fundraising_credit_per_unit ?? "";
    form.elements.is_active.checked = Boolean(product.is_active);

    document.querySelector("#product-dialog-title").textContent = "Edit Product";
    clearNotice(formNotice);
    openDialog(dialog);
  }

  async function saveProduct(event) {
    event.preventDefault();
    clearNotice(formNotice);
    setFormBusy(form, true);

    const data = new FormData(form);
    const id = String(data.get("id") || "");
    const payload = {
      sku: String(data.get("sku") || "").trim(),
      product_name: String(data.get("product_name") || "").trim(),
      supplier_name: normalizeNullable(data.get("supplier_name")),
      supplier_product_name: normalizeNullable(data.get("supplier_product_name")),
      bag_size: String(data.get("bag_size") || "other"),
      cost: Number(data.get("cost") || 0),
      sale_price: Number(data.get("sale_price") || 0),
      fundraising_credit_per_unit: Number(data.get("fundraising_credit_per_unit") || 0),
      is_active: data.get("is_active") === "on",
      updated_by: user.id
    };

    if (!id) payload.created_by = user.id;

    try {
      await ProductsService.save(id, payload);
      closeDialog(dialog);
      setNotice(notice, id ? "Product updated." : "Product added.", "success");
      await load();
    } catch (error) {
      setNotice(formNotice, error.message, "error");
    } finally {
      setFormBusy(form, false);
    }
  }

  await load();
}

function dialogHtml() {
  return `
    <dialog class="portal-dialog portal-dialog--wide" id="product-dialog">
      <form method="post" class="dialog-card" id="product-form">
        <div class="dialog-header">
          <h2 id="product-dialog-title">Product</h2>
          <button type="button" class="icon-button" data-close aria-label="Close">×</button>
        </div>
        <input type="hidden" name="id">
        <div class="form-grid">
          <label class="form-field">
            <span>SKU</span>
            <input name="sku" required>
          </label>
          <label class="form-field">
            <span>Bag size</span>
            <select name="bag_size">
              <option value="12oz">12 oz</option>
              <option value="16oz">16 oz</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label class="form-field form-field--full">
            <span>Product name</span>
            <input name="product_name" required>
          </label>
          <label class="form-field">
            <span>Supplier</span>
            <input name="supplier_name">
          </label>
          <label class="form-field">
            <span>Supplier product</span>
            <input name="supplier_product_name">
          </label>
          <label class="form-field">
            <span>Cost</span>
            <input name="cost" type="number" min="0" step="0.01" required>
          </label>
          <label class="form-field">
            <span>Sale price</span>
            <input name="sale_price" type="number" min="0" step="0.01" required>
          </label>
          <label class="form-field">
            <span>Credit per bag</span>
            <input name="fundraising_credit_per_unit" type="number" min="0" step="0.01" required>
          </label>
          <label class="checkbox-field">
            <input name="is_active" type="checkbox" checked> Active
          </label>
        </div>
        <div id="product-form-notice" class="notice" hidden></div>
        <div class="dialog-actions">
          <button type="button" class="portal-button portal-button--secondary" data-close>Cancel</button>
          <button type="submit" class="portal-button">Save Product</button>
        </div>
      </form>
    </dialog>
  `;
}
