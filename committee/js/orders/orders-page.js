// v1.9.8 packing-sheet status/cache fix
import { OrdersService } from "../services/orders-service.js?v=1.9.14";
import { PurchaseOrdersService } from "../services/purchase-orders-service.js?v=1.8.9";
import { parseEcwidOrderEmail } from "./ecwid-email-import.js?v=1.5.5";
import { requirePortalUser } from "../../assets/auth-common.js";
import { renderPortalLayout, escapeHtml } from "../components/layout.js?v=1.9.0";
import { DataGrid } from "../components/data-grid.js";
import { confirmAction } from "../components/confirm-dialog.js?v=1.9.4";
import { hasMinimumRole } from "../shared/roles.js";
import { getOrderWorkflow } from "../shared/order-workflow.js?v=1.9.2";
import { customerAddress, evaluateDeliveryAreas } from "../shared/delivery-matching.js?v=1.0.0";
import {
  clearNotice, closeDialog, openDialog, setFormBusy, setNotice, normalizeNullable
} from "../master-data/shared.js";

const LABELS = {
  payment_status: {
    unpaid: "Unpaid",
    partially_paid: "Partially Paid",
    paid: "Paid",
    refunded: "Refunded"
  },
  wholesaler_status: {
    not_ready: "Not Ready",
    ready_to_submit: "Ready to Order",
    partially_ordered: "Partially Ordered",
    submitted: "Roaster Processing",
    in_process: "Partially Received",
    received: "Received"
  },
  delivery_status: {
    not_ready: "Not Ready",
    ready_for_pickup: "Ready for Pickup",
    out_for_delivery: "Out for Delivery",
    delivered: "Delivered"
  },
  fulfillment_method: {
    pickup: "Pickup / No Delivery Needed",
    local_delivery: "Local Delivery",
    shipping: "Shipping"
  },
  shipping_status: {
    not_ready: "Not Ready",
    ready_to_ship: "Ready to Ship",
    shipped: "Shipped",
    delivered: "Delivered"
  }
};

const ORDER_DRAFT_KEY = "friends323:new-order-draft";
const EMAIL_IMPORT_USERS = new Set(["coffee_bean@lspack323.com"]);

const result = await requirePortalUser();
if (result) await initialize(result);

async function initialize({ user, profile }) {
  const canEdit = hasMinimumRole(profile.role, "barista");
  const canVoid = hasMinimumRole(profile.role, "coffee_bean");
  const isCoffeeBean = profile.role === "coffee_bean";
  const canImportEmail = isCoffeeBean && EMAIL_IMPORT_USERS.has(String(user.email || "").toLowerCase());
  const assignedDenId = profile.den_id || "";
  const content = renderPortalLayout({ profile, user, pageTitle: "Orders" });

  content.innerHTML = `
    <div class="breadcrumb">Committee Portal / Orders</div>
    <div class="page-heading">
      <div>
        <h1>Orders</h1>
        <p>Create, update, fulfill, and review coffee fundraiser orders.</p>
      </div>
      <div class="page-heading__actions">
        ${isCoffeeBean ? '<button class="portal-button portal-button--secondary" id="recheck-delivery" type="button">Recheck Local Delivery</button>' : ""}
        ${canImportEmail ? '<button class="portal-button portal-button--secondary" id="import-order-email" type="button">Import Email</button><input id="import-order-email-file" type="file" accept=".eml,message/rfc822" hidden>' : ""}
        ${canEdit ? '<button class="portal-button" id="new-order" type="button">New Order</button>' : ""}
      </div>
    </div>
    <div id="page-notice" class="notice" hidden></div>
    ${canEdit ? `
      <section class="orders-shipping-actions" aria-label="Shipping actions">
        <div>
          <strong>Order Fulfillment</strong>
          <span>Print packing sheets for orders being packed, then address labels for orders being shipped.</span>
        </div>
        <div class="orders-shipping-actions__buttons">
          <button class="portal-button portal-button--secondary" id="print-packing-sheets" type="button">Print Packing Sheets</button>
          <button class="portal-button portal-button--secondary" id="print-shipping-labels" type="button">Buy & Print Shipping Labels</button>
        </div>
      </section>` : ""}
    <section class="panel"><div id="orders-grid"></div></section>
    <div id="delivery-print-area"></div>
    ${canEdit ? orderDialog() : ""}
    ${detailDialog(canVoid)}
    ${canVoid ? voidDialog() : ""}
  `;

  const notice = document.querySelector("#page-notice");
  let orders = [];
  let customers = [];
  let products = [];
  let scouts = [];
  let recentCustomerIds = [];
  let pendingImportedCustomer = null;
  let deliveryAreas = [];
  let deliveryEligibility = new Map();
  let deliveryRefreshRunning = false;

  const grid = new DataGrid({
    container: "#orders-grid",
    columns: [
      {
        key: "order_number",
        label: "Order",
        render: row => `
          <button class="link-button" data-view="${row.id}">#${row.order_number}</button>
          ${row.store_order_number
            ? `<div class="cell-note">Store ${escapeHtml(row.store_order_number)}</div>`
            : row.ecwid_order_number
              ? `<div class="cell-note">Ecwid ${escapeHtml(row.ecwid_order_number)}</div>`
              : ""}
        `
      },
      { key: "order_date", label: "Date", render: row => formatDate(row.order_date) },
      {
        key: "customer_name",
        label: "Customer",
        render: row => `<strong>${escapeHtml(row.customer_name)}</strong>`
      },
      {
        key: "fulfillment_label",
        label: "Fulfillment",
        render: row => renderFulfillmentCell(row),
        exportValue: row => row.fulfillment_label || "Not Set"
      },
      {
        key: "scout_display",
        label: "Scout",
        render: row => escapeHtml(row.scout_display || "—")
      },
      {
        key: "order_total",
        label: "Total",
        render: row => money(row.order_total),
        exportValue: row => row.order_total
      },
      {
        key: "progress_label",
        label: "Progress",
        render: row => `
          <button class="progress-link" type="button" data-view="${row.id}"
                  aria-label="Open order #${row.order_number}: ${escapeHtml(row.progress_label)}">
            ${progressBadge(row)}
          </button>
        `,
        exportValue: row => row.progress_label
      },
      {
        key: "record_status",
        label: "Record",
        render: row => badge(
          row.record_status === "voided" ? "Voided" : "Active",
          row.record_status
        )
      }
    ],
    searchFields: [
      "order_number", "store_order_number", "ecwid_order_number", "customer_name", "fulfillment_label", "delivery_eligibility_text", "scout_display", "progress_label",
      "payment_status", "wholesaler_status", "delivery_status", "fulfillment_method", "shipping_status", "shipping_carrier", "shipping_tracking_number"
    ],
    pageSize: 15,
    emptyMessage: "No orders found.",
    exportFileName: "friends-323-orders.csv",
    filters: [
      {
        key: "status",
        label: "Status",
        type: "select",
        options: [
          { value: "active", label: "Active orders" },
          { value: "all", label: "All orders" },
          { value: "voided", label: "Voided orders" }
        ],
        defaultValue: "active",
        predicate: (row, value) => value === "all" || row.record_status === value
      },
      {
        key: "den",
        label: "Den",
        type: "select",
        options: denFilterOptions(profile),
        defaultValue: "all",
        predicate: (row, value) => value === "all" || (row.den_ids || []).includes(value)
      },
      {
        key: "workflow",
        label: "Workflow",
        type: "select",
        options: [
          { value: "all", label: "All Workflows" },
          { value: "payment", label: "Awaiting Payment" },
          { value: "roaster", label: "Ready to Order" },
          { value: "partial_order", label: "Partially Ordered" },
          { value: "processing", label: "Roaster Processing" },
          { value: "partial_received", label: "Partially Received" },
          { value: "received", label: "Coffee Received" },
          { value: "pickup", label: "Ready for Pickup" },
          { value: "shipping_ready", label: "Ready to Ship" },
          { value: "shipped", label: "Shipped" },
          { value: "delivered", label: "Delivered" }
        ],
        defaultValue: "all",
        predicate: (row, value) => value === "all" || row.progress_key === value
      },
      {
        key: "hide_completed",
        label: "Completed Orders",
        type: "toggle-button",
        defaultValue: true,
        activeLabel: "Completed Orders: Hidden",
        inactiveLabel: "Completed Orders: Shown",
        activeClass: "portal-button--completed-hidden",
        inactiveClass: "portal-button--completed-shown",
        predicate: (row, hideCompleted) => !hideCompleted || !(
          row.record_status === "voided" ||
          (row.payment_status === "paid" && row.delivery_status === "delivered")
        )
      }
    ],
    rowActions: row => `
      ${canEdit && row.record_status === "active"
        ? `<button class="table-action" data-edit="${row.id}">Edit</button>`
        : ""}
      <button class="table-action" data-view="${row.id}">View</button>
    `
  });

  const pageParams = new URLSearchParams(window.location.search);
  const workflowAliases = {
    unpaid: "payment",
    ready_roaster: "roaster",
    ready_for_pickup: "pickup"
  };
  const requestedWorkflowRaw = pageParams.get("workflow");
  const requestedWorkflow = workflowAliases[requestedWorkflowRaw] || requestedWorkflowRaw;
  if (["payment", "roaster", "partial_order", "processing", "received", "pickup", "shipping_ready", "shipped", "delivered"].includes(requestedWorkflow)) {
    grid.filterValues.workflow = requestedWorkflow;
    const workflowControl = grid.container.querySelector('[data-filter="workflow"]');
    if (workflowControl) workflowControl.value = requestedWorkflow;
    grid.refresh();
  }

  grid.container.addEventListener("datagrid:render", bindGridButtons);
  document.querySelector("#new-order")?.addEventListener("click", () => openOrderEditor());
  document.querySelector("#print-packing-sheets")?.addEventListener("click", () => printPackingSheets(notice, orders));
  document.querySelector("#print-shipping-labels")?.addEventListener("click", () => openBatchShippingLabelDialog({ orders, user, loadOrders, pageNotice: notice }));
  if (canImportEmail) setupEmailImport();

  function setupEmailImport() {
    const button = document.querySelector("#import-order-email");
    const input = document.querySelector("#import-order-email-file");
    if (!button || !input) return;

    button.addEventListener("click", () => {
      input.value = "";
      input.click();
    });

    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = parseEcwidOrderEmail(await file.text());
        const duplicate = orders.find(order =>
          String(order.ecwid_order_number || "").toUpperCase() === parsed.order_number.toUpperCase()
        );
        if (duplicate) {
          setNotice(notice, `Ecwid order ${parsed.order_number} is already in the portal as Order #${duplicate.order_number}.`, "error");
          return;
        }
        await openImportedOrder(parsed);
      } catch (error) {
        setNotice(notice, `Email could not be imported: ${error.message}`, "error");
      }
    });
  }

  async function openImportedOrder(parsed) {
    openOrderEditor();
    const form = document.querySelector("#order-form");
    const items = document.querySelector("#order-items");
    const formNotice = document.querySelector("#order-form-notice");
    items.innerHTML = "";

    form.elements.order_date.value = parsed.order_date;
    form.elements.ecwid_order_number.value = parsed.order_number;
    form.elements.payment_status.value = parsed.payment_status;
    form.elements.amount_paid.value = parsed.amount_paid || 0;
    form.elements.payment_method.value = parsed.payment_method || "";
    form.elements.wholesaler_status.value = "not_ready";
    form.elements.delivery_status.value = "not_ready";
    form.elements.fulfillment_method.value = "";

    const notes = [];
    if (parsed.non_coffee_amount > 0) {
      notes.push(`Ecwid order total ${money(parsed.ecwid_total)} includes ${money(parsed.non_coffee_amount)} in non-coffee charges not included in portal coffee lines.`);
    }
    form.elements.notes.value = notes.join("\n");

    const existingCustomer = customers.find(customer =>
      parsed.customer.email && String(customer.email || "").toLowerCase() === parsed.customer.email.toLowerCase()
    );
    if (existingCustomer) {
      pendingImportedCustomer = null;
      form.elements.customer_id.value = existingCustomer.id;
      form.elements.customer_search.value = customerName(existingCustomer);
    } else {
      pendingImportedCustomer = parsed.customer;
      form.elements.customer_id.value = "";
      form.elements.customer_search.value = [parsed.customer.first_name, parsed.customer.last_name].filter(Boolean).join(" ");
    }

    const unmatched = [];
    parsed.items.forEach(imported => {
      const product = findImportedProduct(products, imported);
      const scout = findImportedScout(scouts, imported.scout_name, parsed.order_comments);
      if (!product || !scout) {
        unmatched.push(`${imported.product_name}${!product ? ` (SKU ${imported.sku} / ${imported.size} not matched)` : ""}${!scout ? ` (scout ${imported.scout_name} not matched)` : ""}`);
      }
      window.__addImportedOrderLine?.({
        product_id: product?.id || "",
        product_search: product ? productLabel(product) : `${imported.product_name} — ${imported.size}`,
        quantity: imported.quantity,
        scout_id: scout?.id || "",
        scout_search: scout ? scoutName(scout) : imported.scout_name,
        unit_price: product?.sale_price ?? imported.unit_price,
        unit_fundraising_credit: product?.fundraising_credit_per_unit || 0,
        grind: imported.grind
      });
    });

    const messages = [`Ecwid order ${parsed.order_number} imported. Review it before saving.`];
    if (!existingCustomer) messages.push("This customer is new and will be created when you save the order.");
    if (unmatched.length) messages.push(`Review unmatched data: ${unmatched.join("; ")}.`);
    setNotice(formNotice, messages.join(" "), unmatched.length ? "error" : "success");
  }

  // Default Orders view: newest orders first.
  grid.sortKey = "order_date";
  grid.sortDirection = "desc";

  async function loadReferenceData() {
    const refs = await OrdersService.references();
    customers = refs.customers;
    products = refs.products;
    scouts = refs.scouts;
  }

  async function loadOrders() {
    try {
      const [data, eligibilityRows, areas] = await Promise.all([
        OrdersService.list(),
        OrdersService.listDeliveryEligibility(),
        isCoffeeBean ? OrdersService.listActiveDeliveryAreas() : Promise.resolve([])
      ]);
      deliveryAreas = areas || [];
      deliveryEligibility = new Map((eligibilityRows || []).map(row => [row.order_id, row]));
      orders = (data || []).map(order => {
        const eligibility = deliveryEligibility.get(order.id) || null;
        const mapped = {
          ...order,
          customer_name: customerName(order.customers),
          delivery_eligibility: eligibility,
          delivery_eligibility_text: deliveryEligibilityText(eligibility),
          fulfillment_label: fulfillmentMethodLabel(order.fulfillment_method),
          scout_display: [...new Set((order.order_items || []).map(item => scoutName(item.scouts || {})).filter(Boolean))].join(", "),
          den_ids: [...new Set((order.order_items || []).map(item => item.scouts?.den_id).filter(Boolean))],
          order_total: (order.order_items || [])
            .reduce((sum, item) => sum + Number(item.line_total || 0), 0)
            + Number(order.processing_cost || 0)
            + Number(order.shipping_amount || 0),
          fundraising_credit_total: (order.order_items || [])
            .reduce((sum, item) => sum + Number(item.fundraising_credit_total || 0), 0)
        };
        const workflow = getOrderWorkflow(mapped);
        return {
          ...mapped,
          progress_key: workflow.key,
          progress_label: workflow.label,
          progress_tone: workflow.tone
        };
      });

      recentCustomerIds = [...new Set(
        orders
          .filter(order => order.record_status === "active")
          .map(order => order.customer_id)
          .filter(Boolean)
      )].slice(0, 8);

      grid.setRows(orders);
      populateDenFilter(grid, scouts, profile);

      if (isCoffeeBean) {
        await refreshDeliveryEligibility({ force:true, silent:true });
      }
    } catch (error) {
      setNotice(notice, `Orders could not be loaded: ${error.message}`, "error");
    }
  }

  async function refreshDeliveryEligibility({ force = false, silent = false } = {}) {
    if (!isCoffeeBean || deliveryRefreshRunning) return;
    deliveryRefreshRunning = true;
    const button = document.querySelector("#recheck-delivery");
    if (button) {
      button.disabled = true;
      button.textContent = "Checking Delivery…";
    }

    try {
      const configUpdatedAt = newestDeliveryConfigTime(deliveryAreas);
      const candidates = orders.filter(order =>
        order.record_status === "active" &&
        order.delivery_status !== "delivered" &&
        order.fulfillment_method === "local_delivery"
      );
      let checked = 0;
      let changed = 0;

      for (const order of candidates) {
        const address = customerAddress(order.customers || {});
        const current = deliveryEligibility.get(order.id) || null;
        if (!force && !deliveryCheckIsStale(current, address, configUpdatedAt)) continue;
        checked += 1;
        const result = await evaluateOrderDelivery(order, address, configUpdatedAt);
        deliveryEligibility.set(order.id, result);
        order.delivery_eligibility = result;
        order.delivery_eligibility_text = deliveryEligibilityText(result);
        changed += 1;
      }

      if (changed) grid.setRows(orders);
      if (!silent) {
        setNotice(notice, checked
          ? `Delivery eligibility checked for ${checked} order${checked === 1 ? "" : "s"}.`
          : "Delivery eligibility is already current.", "success");
      }
    } catch (error) {
      setNotice(notice, `Delivery eligibility could not be checked: ${error.message}`, "error");
    } finally {
      deliveryRefreshRunning = false;
      if (button) {
        button.disabled = false;
        button.textContent = "Recheck Local Delivery";
      }
    }
  }

  async function evaluateOrderDelivery(order, address, configUpdatedAt) {
    const checkedAt = new Date().toISOString();
    if (!address) {
      return OrdersService.saveDeliveryEligibility(order.id, {
        status: "no_address",
        address_snapshot: null,
        matches: [],
        route_config_updated_at: configUpdatedAt,
        checked_at: checkedAt,
        error_message: null
      });
    }

    if (!deliveryAreas.length) {
      return OrdersService.saveDeliveryEligibility(order.id, {
        status: "no_active_areas",
        address_snapshot: address,
        matches: [],
        route_config_updated_at: configUpdatedAt,
        checked_at: checkedAt,
        error_message: null
      });
    }

    const customer = order.customers || {};
    let latitude = Number(customer.geocode_latitude);
    let longitude = Number(customer.geocode_longitude);
    const cacheCurrent = Number.isFinite(latitude) && Number.isFinite(longitude) && customer.geocode_address === address;

    try {
      if (!cacheCurrent) {
        const geocode = await OrdersService.geocodeAddress(address);
        latitude = Number(geocode.latitude);
        longitude = Number(geocode.longitude);
        const geocodeValues = {
          geocode_latitude: latitude,
          geocode_longitude: longitude,
          geocode_address: address,
          geocode_source: geocode.source || "US Census Geocoder",
          geocoded_at: checkedAt
        };
        await OrdersService.saveCustomerGeocode(order.customer_id, geocodeValues);
        Object.assign(customer, geocodeValues);
      }

      const matches = evaluateDeliveryAreas(deliveryAreas, latitude, longitude);
      const eligible = matches.some(item => item.eligible);
      return OrdersService.saveDeliveryEligibility(order.id, {
        status: eligible ? "eligible" : "shipping_required",
        address_snapshot: address,
        matches,
        route_config_updated_at: configUpdatedAt,
        checked_at: checkedAt,
        error_message: null
      });
    } catch (error) {
      return OrdersService.saveDeliveryEligibility(order.id, {
        status: "geocode_failed",
        address_snapshot: address,
        matches: [],
        route_config_updated_at: configUpdatedAt,
        checked_at: checkedAt,
        error_message: error.message || "Address could not be matched."
      });
    }
  }

  function deliveryCheckIsStale(current, address, configUpdatedAt) {
    if (!current) return true;
    if ((current.address_snapshot || "") !== (address || "")) return true;
    if (!current.checked_at) return true;
    const checked = new Date(current.checked_at).getTime();
    const config = configUpdatedAt ? new Date(configUpdatedAt).getTime() : 0;
    return Number.isFinite(config) && config > checked;
  }

  function newestDeliveryConfigTime(areas) {
    let newest = 0;
    for (const area of areas || []) {
      for (const value of [area.updated_at, area.driver_updated_at]) {
        const time = new Date(value || 0).getTime();
        if (Number.isFinite(time)) newest = Math.max(newest, time);
      }
    }
    return newest ? new Date(newest).toISOString() : null;
  }

  function bindGridButtons() {
    grid.container.querySelectorAll("[data-view]").forEach(button =>
      button.addEventListener("click", () => showDetail(button.dataset.view)));
    grid.container.querySelectorAll("[data-edit]").forEach(button =>
      button.addEventListener("click", () => openOrderEditor(button.dataset.edit)));
  }

  document.querySelector("#recheck-delivery")?.addEventListener("click", () => refreshDeliveryEligibility({ force:true }));

  if (canEdit) setupOrderEditor();
  setupDetail();
  if (canVoid) setupVoid();

  function setupOrderEditor() {
    const dialog = document.querySelector("#order-dialog");
    const form = document.querySelector("#order-form");
    const items = document.querySelector("#order-items");
    const formNotice = document.querySelector("#order-form-notice");
    const customerInput = form.elements.customer_search;
    const customerIdInput = form.elements.customer_id;
    const customerResults = document.querySelector("#customer-results");
    const recentCustomers = document.querySelector("#recent-customers");

    dialog.querySelectorAll("[data-close]").forEach(button =>
      button.addEventListener("click", () => closeDialog(dialog)));

    document.querySelector("#add-line").addEventListener("click", () => addLine({}, { placeAtTop: true }));

    items.addEventListener("click", event => {
      const remove = event.target.closest("[data-remove-line]");
      if (remove) {
        remove.closest(".order-line").remove();
        updateTotals();
      }
    });

    items.addEventListener("input", event => {
      if (event.target.matches("[name='product_search']")) {
        updateProductResults(event.target.closest(".order-line"));
      }
      updateTotals();
    });

    form.addEventListener("submit", saveOrder);
    form.elements.fulfillment_method.addEventListener("change", updateShippingEditorVisibility);

    customerInput.addEventListener("input", () => {
      customerIdInput.value = "";
      renderCustomerResults(customerInput.value);
    });
    customerInput.addEventListener("focus", () => renderCustomerResults(customerInput.value));

    document.addEventListener("click", event => {
      if (!event.target.closest(".autocomplete")) {
        customerResults.hidden = true;
        document.querySelectorAll(".autocomplete-results").forEach(result => result.hidden = true);
      }
    });

    window.__openOrderEditor = async function(id = null) {
      clearNotice(formNotice);
      pendingImportedCustomer = null;
      form.reset();
      items.innerHTML = "";
      form.elements.id.value = id || "";

      const order = orders.find(item => item.id === id);
      const ecwidField = document.querySelector("#ecwid-order-field");
      const storefrontField = document.querySelector("#storefront-order-field");

      if (order) {
        document.querySelector("#order-dialog-title").textContent =
          `Edit Order #${order.order_number}`;

        customerIdInput.value = order.customer_id;
        customerInput.value = order.customer_name;

        for (const field of [
          "order_date", "ecwid_order_number", "payment_status",
          "wholesaler_status", "delivery_status", "fulfillment_method", "shipping_status", "shipping_carrier", "shipping_tracking_number", "payment_method",
          "amount_paid", "notes"
        ]) {
          form.elements[field].value = order[field] ?? "";
        }

        if (order.store_order_number) {
          storefrontField.hidden = false;
          ecwidField.hidden = true;
          form.elements.store_order_number.value = order.store_order_number;
        } else {
          storefrontField.hidden = true;
          ecwidField.hidden = false;
          form.elements.store_order_number.value = "";
        }

        (order.order_items || []).forEach(item => addLine(item));
      } else {
        document.querySelector("#order-dialog-title").textContent = "New Order";
        storefrontField.hidden = true;
        ecwidField.hidden = false;
        form.elements.store_order_number.value = "";
        form.elements.order_date.value = new Date().toISOString().slice(0, 10);
        addLine();
      }

      renderRecentCustomers();
      updateTotals();
      updateShippingEditorVisibility();
      openDialog(dialog);
    };

    function updateShippingEditorVisibility() {
      const panel = document.querySelector("#shipping-order-fields");
      if (!panel) return;
      const isShipping = form.elements.fulfillment_method.value === "shipping";
      panel.hidden = !isShipping;
      for (const control of panel.querySelectorAll("input, select")) control.disabled = !isShipping;
    }

    function renderCustomerResults(query) {
      const clean = String(query || "").trim().toLowerCase();
      const matches = customers
        .filter(customer => {
          if (!clean) return recentCustomerIds.includes(customer.id);
          return [
            customerName(customer), customer.email, customer.phone, customer.company_name
          ].some(value => String(value || "").toLowerCase().includes(clean));
        })
        .slice(0, 8);

      customerResults.innerHTML = matches.length
        ? matches.map(customer => `
            <button type="button" class="autocomplete-option"
                    data-customer-id="${customer.id}">
              <strong>${escapeHtml(customerName(customer))}</strong>
              <small>${escapeHtml(customer.email || formatPhoneNumber(customer.phone) || "Customer")}</small>
            </button>
          `).join("")
        : `<a class="autocomplete-create" href="/committee/customers.html?action=new&return=orders"
              data-create-customer>
             + Create New Customer
           </a>`;

      customerResults.hidden = false;
      customerResults.querySelectorAll("[data-customer-id]").forEach(button => {
        button.addEventListener("click", () => selectCustomer(button.dataset.customerId));
      });
      customerResults.querySelector("[data-create-customer]")?.addEventListener("click", () => {
        saveOrderDraft();
      });
    }

    function renderRecentCustomers() {
      const recent = recentCustomerIds
        .map(id => customers.find(customer => customer.id === id))
        .filter(Boolean);

      recentCustomers.innerHTML = recent.length
        ? `<span>Recent customers:</span>${recent.map(customer => `
            <button type="button" data-recent-customer="${customer.id}">
              ${escapeHtml(customerName(customer))}
            </button>
          `).join("")}`
        : "";

      recentCustomers.querySelectorAll("[data-recent-customer]").forEach(button => {
        button.addEventListener("click", () => selectCustomer(button.dataset.recentCustomer));
      });
    }

    function selectCustomer(id) {
      const customer = customers.find(item => item.id === id);
      if (!customer) return;
      customerIdInput.value = customer.id;
      customerInput.value = customerName(customer);
      customerResults.hidden = true;
    }

    function addLine(item = {}, { placeAtTop = false } = {}) {
      const row = document.createElement("div");
      row.className = "order-line";
      row.dataset.orderItemId = item.id || "";
      row.innerHTML = `
        <div class="form-field autocomplete">
          <span>Product</span>
          <input name="product_search" type="search" autocomplete="off"
                 placeholder="Type product name, SKU, or size" required>
          <input name="product_id" type="hidden">
          <div class="autocomplete-results" data-product-results hidden></div>
        </div>
        <label class="form-field">
          <span>Quantity</span>
          <input name="quantity" type="number" min="1" step="1"
                 value="${item.quantity || 1}" required>
        </label>
        <label class="form-field">
          <span>Received Qty</span>
          <input name="quantity_received" type="number" min="0" step="1"
                 max="${item.quantity || 1}" value="${item.quantity_received || 0}" required>
        </label>
        <div class="form-field autocomplete">
          <span>Scout / Fund</span>
          <input name="scout_search" type="search" autocomplete="off"
                 placeholder="Type scout or General Fund" required>
          <input name="scout_id" type="hidden">
          <div class="autocomplete-results" data-scout-results hidden></div>
        </div>
        <label class="form-field">
          <span>Grind</span>
          <select name="grind">
            <option value="Whole Bean">Whole Bean</option>
            <option value="Ground">Ground</option>
          </select>
        </label>
        <div class="order-line-pricing">
          <span data-line-price>${money(item.unit_price || 0)}</span>
          <span data-line-credit>${money(item.unit_fundraising_credit || 0)} credit/bag</span>
        </div>
        <button type="button" class="icon-button remove-line"
                data-remove-line aria-label="Remove line">×</button>
      `;

      const quantityInput = row.querySelector("[name='quantity']");
      const receivedInput = row.querySelector("[name='quantity_received']");
      quantityInput.addEventListener("input", () => {
        receivedInput.max = Math.max(0, Number(quantityInput.value || 0));
        if (Number(receivedInput.value || 0) > Number(quantityInput.value || 0)) {
          receivedInput.value = quantityInput.value || 0;
        }
        updateTotals();
      });

      const scoutIdInput = row.querySelector("[name='scout_id']");
      const scoutSearchInput = row.querySelector("[name='scout_search']");
      const selectedScout = scouts.find(scout => scout.id === item.scout_id);
      scoutIdInput.value = item.scout_id || "";
      scoutSearchInput.value = selectedScout ? scoutName(selectedScout) : (item.scout_search || "");

      scoutSearchInput.addEventListener("focus", () => updateScoutResults(row));
      scoutSearchInput.addEventListener("input", () => {
        scoutIdInput.value = "";
        updateScoutResults(row);
      });
      row.querySelector("[data-scout-results]").addEventListener("click", event => {
        const option = event.target.closest("[data-scout-id]");
        if (option) selectScout(row, option.dataset.scoutId);
      });

      row.querySelector("[name='grind']").value =
        normalizeGrind(extractGrind(item.notes));
      const product = products.find(product => product.id === item.product_id);
      row.querySelector("[name='product_id']").value = item.product_id || "";
      row.querySelector("[name='product_search']").value = product
        ? productLabel(product)
        : item.products
          ? `${item.products.product_name} — ${item.products.bag_size}`
          : "";

      const searchInput = row.querySelector("[name='product_search']");
      searchInput.addEventListener("focus", () => updateProductResults(row));
      searchInput.addEventListener("input", () => {
        // A user edit invalidates the selected product ID; simply focusing the
        // field must not clear an already matched/imported product.
        row.querySelector("[name='product_id']").value = "";
        updateProductResults(row);
      });
      row.querySelector("[data-product-results]").addEventListener("click", event => {
        const option = event.target.closest("[data-product-id]");
        if (option) selectProduct(row, option.dataset.productId);
      });

      if (placeAtTop) items.prepend(row);
      else items.appendChild(row);
      populateLinePrice(row, item);
      updateTotals();
    }

    window.__addImportedOrderLine = function(imported) {
      addLine({
        product_id: imported.product_id,
        quantity: imported.quantity,
        scout_id: imported.scout_id,
        scout_search: imported.scout_search,
        unit_price: imported.unit_price,
        unit_fundraising_credit: imported.unit_fundraising_credit,
        notes: `Grind: ${imported.grind || "Whole Bean"}`
      });
      const row = items.lastElementChild;
      if (row && !imported.product_id) {
        row.querySelector("[name='product_search']").value = imported.product_search || "";
      }
    };

    function updateScoutResults(row) {
      const input = row.querySelector("[name='scout_search']");
      const results = row.querySelector("[data-scout-results]");
      const clean = normalizeMatchText(input.value);

      const matches = scouts
        .filter(scout => scout.is_active || scout.id === row.querySelector("[name='scout_id']").value)
        .filter(scout => {
          if (!clean) return true;
          const plain = normalizeMatchText(scoutPlainName(scout));
          const display = normalizeMatchText(scoutName(scout));
          return plain.includes(clean) || display.includes(clean);
        })
        .slice(0, 12);

      results.innerHTML = matches.length
        ? matches.map(scout => `
            <button type="button" class="autocomplete-option"
                    data-scout-id="${scout.id}">
              <strong>${escapeHtml(scoutPlainName(scout))}</strong>
              <small>${escapeHtml(scoutDenLabel(scout))}</small>
            </button>
          `).join("")
        : `<div class="autocomplete-empty">No active scouts match.</div>`;
      results.hidden = false;
    }

    function selectScout(row, id) {
      const scout = scouts.find(item => item.id === id);
      if (!scout) return;
      row.querySelector("[name='scout_id']").value = scout.id;
      row.querySelector("[name='scout_search']").value = scoutName(scout);
      row.querySelector("[data-scout-results]").hidden = true;
    }

    function updateProductResults(row) {
      const input = row.querySelector("[name='product_search']");
      const results = row.querySelector("[data-product-results]");
      const clean = normalizeMatchText(input.value);
      const terms = clean.split(" ").filter(Boolean);

      const matches = products
        .filter(product => product.is_active !== false)
        .filter(product => {
          if (!terms.length) return true;
          const searchable = normalizeMatchText([
            product.product_name, product.sku, product.bag_size,
            product.supplier_product_name, productLabel(product)
          ].filter(Boolean).join(" "));
          return terms.every(term => searchable.includes(term));
        })
        .slice(0, 10);

      results.innerHTML = matches.length
        ? matches.map(product => `
            <button type="button" class="autocomplete-option"
                    data-product-id="${product.id}">
              <strong>${escapeHtml(productLabel(product))}</strong>
              <small>${escapeHtml(product.sku)} · ${money(product.sale_price)}
                · ${money(product.fundraising_credit_per_unit)} credit</small>
            </button>
          `).join("")
        : `<div class="autocomplete-empty">No active products match.</div>`;
      results.hidden = false;
    }

    function selectProduct(row, id) {
      const product = products.find(item => item.id === id);
      if (!product) return;
      row.querySelector("[name='product_id']").value = product.id;
      row.querySelector("[name='product_search']").value = productLabel(product);
      row.querySelector("[data-product-results]").hidden = true;
      populateLinePrice(row);
      updateTotals();
    }

    function populateLinePrice(row, item = null) {
      const product = products.find(
        product => product.id === row.querySelector("[name='product_id']").value
      );
      const price = item?.unit_price ?? product?.sale_price ?? 0;
      const credit = item?.unit_fundraising_credit
        ?? product?.fundraising_credit_per_unit ?? 0;
      row.dataset.unitPrice = price;
      row.dataset.unitCredit = credit;
      row.querySelector("[data-line-price]").textContent = money(price);
      row.querySelector("[data-line-credit]").textContent =
        `${money(credit)} credit/bag`;
    }

    function updateTotals() {
      let total = 0;
      let credit = 0;
      items.querySelectorAll(".order-line").forEach(row => {
        const quantity = Number(row.querySelector("[name='quantity']").value || 0);
        total += quantity * Number(row.dataset.unitPrice || 0);
        credit += quantity * Number(row.dataset.unitCredit || 0);
      });
      document.querySelector("#order-total").textContent = money(total);
      document.querySelector("#order-credit").textContent = money(credit);
    }

    function saveOrderDraft() {
      const draft = {
        fields: Object.fromEntries([
          "order_date", "ecwid_order_number", "payment_status",
          "wholesaler_status", "delivery_status", "fulfillment_method", "shipping_status", "shipping_carrier", "shipping_tracking_number", "payment_method",
          "amount_paid", "notes"
        ].map(name => [name, form.elements[name]?.value ?? ""])),
        items: [...items.querySelectorAll(".order-line")].map(row => ({
          product_id: row.querySelector("[name='product_id']").value,
          product_search: row.querySelector("[name='product_search']").value,
          quantity: row.querySelector("[name='quantity']").value,
          quantity_received: row.querySelector("[name='quantity_received']").value,
          scout_id: row.querySelector("[name='scout_id']").value,
          scout_search: row.querySelector("[name='scout_search']").value,
          grind: row.querySelector("[name='grind']").value,
          unit_price: Number(row.dataset.unitPrice || 0),
          unit_fundraising_credit: Number(row.dataset.unitCredit || 0)
        }))
      };
      sessionStorage.setItem(ORDER_DRAFT_KEY, JSON.stringify(draft));
    }

    function restoreOrderDraft(customerId) {
      let draft = null;
      try {
        draft = JSON.parse(sessionStorage.getItem(ORDER_DRAFT_KEY) || "null");
      } catch {
        draft = null;
      }

      window.__openOrderEditor?.();
      if (!draft) {
        if (customerId) selectCustomer(customerId);
        return;
      }

      Object.entries(draft.fields || {}).forEach(([name, value]) => {
        if (form.elements[name]) form.elements[name].value = value ?? "";
      });

      items.innerHTML = "";
      (draft.items || []).forEach(saved => {
        addLine({
          product_id: saved.product_id,
          quantity: saved.quantity,
          quantity_received: saved.quantity_received,
          scout_id: saved.scout_id,
          scout_search: saved.scout_search,
          unit_price: saved.unit_price,
          unit_fundraising_credit: saved.unit_fundraising_credit,
          notes: `Grind: ${saved.grind || "Whole Bean"}`
        });
        const row = items.lastElementChild;
        if (row && !saved.product_id) {
          row.querySelector("[name='product_search']").value = saved.product_search || "";
        }
      });
      if (!(draft.items || []).length) addLine();

      if (customerId) selectCustomer(customerId);
      sessionStorage.removeItem(ORDER_DRAFT_KEY);
      updateTotals();
      updateShippingEditorVisibility();
    }

    async function saveOrder(event) {
      event.preventDefault();
      clearNotice(formNotice);
      const rows = [...items.querySelectorAll(".order-line")];

      if (!form.elements.customer_id.value && !pendingImportedCustomer) {
        setNotice(formNotice, "Select a customer from the search results.", "error");
        return;
      }
      if (!rows.length) {
        setNotice(formNotice, "Add at least one order item.", "error");
        return;
      }
      if (rows.some(row => !row.querySelector("[name='product_id']").value)) {
        setNotice(formNotice, "Select each product from the search results.", "error");
        return;
      }
      if (rows.some(row => !row.querySelector("[name='scout_id']").value)) {
        setNotice(formNotice, "Select each Scout / Fund from the search results.", "error");
        return;
      }
      if (rows.some(row => Number(row.querySelector("[name='quantity_received']").value || 0) > Number(row.querySelector("[name='quantity']").value || 0))) {
        setNotice(formNotice, "Received quantity cannot be greater than ordered quantity.", "error");
        return;
      }

      if (!form.elements.customer_id.value && pendingImportedCustomer) {
        try {
          const created = await OrdersService.createCustomer({
            ...pendingImportedCustomer,
            created_by: user.id,
            updated_by: user.id
          });
          customers.push(created);
          form.elements.customer_id.value = created.id;
          form.elements.customer_search.value = customerName(created);
          pendingImportedCustomer = null;
        } catch (error) {
          setNotice(formNotice, `Customer could not be created: ${error.message}`, "error");
          return;
        }
      }

      const fd = new FormData(form);
      const id = String(fd.get("id") || "");
      const orderPayload = {
        customer_id: fd.get("customer_id"),
        order_date: fd.get("order_date"),
        ecwid_order_number: normalizeNullable(fd.get("ecwid_order_number")),
        payment_status: fd.get("payment_status"),
        wholesaler_status: fd.get("wholesaler_status"),
        delivery_status: fd.get("delivery_status"),
        fulfillment_method: normalizeNullable(fd.get("fulfillment_method")),
        shipping_status: fd.get("fulfillment_method") === "shipping" ? (fd.get("shipping_status") || "not_ready") : "not_ready",
        shipping_carrier: fd.get("fulfillment_method") === "shipping" ? normalizeNullable(fd.get("shipping_carrier")) : null,
        shipping_tracking_number: fd.get("fulfillment_method") === "shipping" ? normalizeNullable(fd.get("shipping_tracking_number")) : null,
        payment_method: normalizeNullable(fd.get("payment_method")),
        amount_paid: Number(fd.get("amount_paid") || 0),
        notes: normalizeNullable(fd.get("notes")),
        updated_by: user.id
      };
      if (!id) orderPayload.created_by = user.id;

      const itemPayloads = rows.map(row => ({
        id: row.dataset.orderItemId || null,
        product_id: row.querySelector("[name='product_id']").value,
        scout_id: row.querySelector("[name='scout_id']").value,
        quantity: Number(row.querySelector("[name='quantity']").value),
        quantity_received: fd.get("wholesaler_status") === "received"
          ? Number(row.querySelector("[name='quantity']").value)
          : Number(row.querySelector("[name='quantity_received']").value || 0),
        unit_price: Number(row.dataset.unitPrice || 0),
        unit_fundraising_credit: Number(row.dataset.unitCredit || 0),
        notes: `Grind: ${row.querySelector("[name='grind']").value || "Whole Bean"}`,
        created_by: user.id,
        updated_by: user.id
      }));

      const totalOrdered = itemPayloads.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      const totalReceived = itemPayloads.reduce((sum, item) => sum + Number(item.quantity_received || 0), 0);
      if (totalReceived > 0 && totalReceived < totalOrdered && ["received", "in_process", "submitted"].includes(orderPayload.wholesaler_status)) {
        orderPayload.wholesaler_status = "in_process";
      } else if (totalOrdered > 0 && totalReceived >= totalOrdered && ["submitted", "in_process", "received"].includes(orderPayload.wholesaler_status)) {
        orderPayload.wholesaler_status = "received";
      }

      setFormBusy(form, true, "Saving order…");
      try {
        await OrdersService.save({ id, order: orderPayload, itemPayloads });
        closeDialog(dialog);
        setNotice(notice, id ? "Order updated." : "Order created.", "success");
        await loadOrders();
      } catch (error) {
        setNotice(formNotice, error.message, "error");
      } finally {
        setFormBusy(form, false);
      }
    }

    window.__restoreOrderDraft = restoreOrderDraft;
  }

  function openOrderEditor(id = null) {
    window.__openOrderEditor?.(id);
  }

  function setupDetail() {
    document.querySelector("#detail-close").addEventListener("click", () =>
      closeDialog(document.querySelector("#order-detail-dialog")));
  }

  function showDetail(id) {
    const order = orders.find(item => item.id === id);
    if (!order) return;

    const dialog = document.querySelector("#order-detail-dialog");
    const detailTitle = document.querySelector("#detail-title");
    detailTitle.textContent = `Order #${order.order_number}`;

    const orderReference = order.store_order_number
      ? `Store ${order.store_order_number}`
      : order.ecwid_order_number
        ? `Ecwid ${order.ecwid_order_number}`
        : "";

    if (orderReference) {
      const referenceLine = document.createElement("span");
      referenceLine.className = "cell-note";
      referenceLine.style.display = "block";
      referenceLine.textContent = orderReference;
      detailTitle.appendChild(referenceLine);
    }

    document.querySelector("#detail-content").innerHTML = `
      ${renderTimeline(order)}

      ${canEdit && order.record_status === "active"
        ? renderWorkflowActions(order)
        : ""}

      <div class="detail-grid">
        <div><span>Customer</span><strong>${escapeHtml(order.customer_name)}</strong></div>
        <div><span>Date</span><strong>${formatDate(order.order_date)}</strong></div>
        <div><span>Total</span><strong>${money(order.order_total)}</strong></div>
        <div><span>Fundraising Credit</span><strong>${money(order.fundraising_credit_total)}</strong></div>
        <div><span>Progress</span>${progressBadge(order)}</div>
        <div><span>Payment</span>${badge(LABELS.payment_status[order.payment_status], order.payment_status)}</div>
        <div><span>Roaster</span>${badge(LABELS.wholesaler_status[order.wholesaler_status], order.wholesaler_status)}</div>
        <div><span>Fulfillment</span><strong>${escapeHtml(fulfillmentMethodLabel(order.fulfillment_method))}</strong></div>
        ${Number(order.shipping_amount || 0) > 0 ? `<div><span>Shipping Charge</span><strong>${money(order.shipping_amount)}</strong><small class="cell-note">${escapeHtml(order.shipping_rate_label || "Configured rate")}</small></div>` : ""}
        ${order.fulfillment_method === "shipping" ? `<div><span>Shipping Status</span>${badge(LABELS.shipping_status[order.shipping_status] || "Not Ready", order.shipping_status || "not_ready")}</div>` : `<div><span>Delivery Status</span>${badge(LABELS.delivery_status[order.delivery_status], order.delivery_status)}</div>`}
        ${order.fulfillment_method === "shipping" ? `<div><span>Carrier Label</span>${order.shipping_label_printed_at ? `<strong>Label Printed</strong><small class="cell-note">${escapeHtml(formatLabelPrintDate(order.shipping_label_printed_at))}</small>` : `<strong>Not Printed</strong>`}</div>` : ""}
      </div>

      ${renderDeliveryEligibilityDetail(order)}
      ${renderShippingDetail(order, canEdit && order.record_status === "active")}

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>Product</th><th>Grind</th><th>Scout</th><th>Qty</th><th>Received</th><th>Price</th><th>Total</th><th>Credit</th></tr>
          </thead>
          <tbody>
            ${(order.order_items || []).map(item => `
              <tr>
                <td>${escapeHtml(item.products?.product_name || "Product")}
                  <div class="cell-note">${escapeHtml(item.products?.bag_size || "")}</div>
                </td>
                <td>${escapeHtml(normalizeGrind(extractGrind(item.notes)))}</td>
                <td>${escapeHtml(scoutName(item.scouts || {}))}</td>
                <td>${item.quantity}</td>
                <td>${Number(item.quantity_received || 0)} / ${item.quantity}</td>
                <td>${money(item.unit_price)}</td>
                <td>${money(item.line_total)}</td>
                <td>${money(item.fundraising_credit_total)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      ${order.notes ? `<p><strong>Notes:</strong> ${escapeHtml(order.notes)}</p>` : ""}
      ${order.record_status === "voided"
        ? `<div class="notice notice--error"><strong>Voided:</strong>
             ${escapeHtml(order.void_reason || "No reason recorded")}</div>`
        : ""}
    `;

    document.querySelector("#detail-content").querySelectorAll("[data-workflow-action]")
      .forEach(button => button.addEventListener("click", async () => {
        await runWorkflowAction(order, button.dataset.workflowAction, button);
      }));

    document.querySelector("#detail-content").querySelector("[data-recheck-order]")?.addEventListener("click", async buttonEvent => {
      const button = buttonEvent.currentTarget;
      button.disabled = true;
      try {
        const address = customerAddress(order.customers || {});
        const result = await evaluateOrderDelivery(order, address, newestDeliveryConfigTime(deliveryAreas));
        deliveryEligibility.set(order.id, result);
        order.delivery_eligibility = result;
        order.delivery_eligibility_text = deliveryEligibilityText(result);
        grid.setRows(orders);
        closeDialog(document.querySelector("#order-detail-dialog"));
        showDetail(order.id);
      } catch (error) {
        setNotice(notice, `Delivery eligibility could not be checked: ${error.message}`, "error");
      }
    });

    document.querySelector("#detail-content").querySelector("[data-add-local-override]")?.addEventListener("click", async buttonEvent => {
      const reason = window.prompt(
        "Why should this order be treated as local?",
        "Customer will pick up through a local family member or planned visit."
      );
      if (reason === null) return;
      const cleanReason = reason.trim();
      if (!cleanReason) {
        setNotice(notice, "Enter a reason for the local-delivery exception.", "error");
        return;
      }
      const button = buttonEvent.currentTarget;
      button.disabled = true;
      try {
        const result = await OrdersService.setManualLocalOverride(order.id, true, cleanReason);
        deliveryEligibility.set(order.id, result);
        order.delivery_eligibility = result;
        order.delivery_eligibility_text = deliveryEligibilityText(result);
        grid.setRows(orders);
        closeDialog(document.querySelector("#order-detail-dialog"));
        showDetail(order.id);
        setNotice(notice, `Order #${order.order_number} is marked Local by Exception.`, "success");
      } catch (error) {
        setNotice(notice, `Local-delivery exception could not be saved: ${error.message}`, "error");
      } finally {
        button.disabled = false;
      }
    });

    document.querySelector("#detail-content").querySelector("[data-remove-local-override]")?.addEventListener("click", async buttonEvent => {
      if (!await confirmAction({ title: "Remove Local Exception?", message: "Remove the local-delivery exception and return to the automatic delivery result?", confirmLabel: "Remove Exception", urgent: true })) return;
      const button = buttonEvent.currentTarget;
      button.disabled = true;
      try {
        const result = await OrdersService.setManualLocalOverride(order.id, false);
        deliveryEligibility.set(order.id, result);
        order.delivery_eligibility = result;
        order.delivery_eligibility_text = deliveryEligibilityText(result);
        grid.setRows(orders);
        closeDialog(document.querySelector("#order-detail-dialog"));
        showDetail(order.id);
        setNotice(notice, `Local exception removed from Order #${order.order_number}.`, "success");
      } catch (error) {
        setNotice(notice, `Local-delivery exception could not be removed: ${error.message}`, "error");
      } finally {
        button.disabled = false;
      }
    });

    const shippingPanel = document.querySelector("#detail-content").querySelector("[data-shipping-panel]");
    shippingPanel?.querySelector("[data-save-shipping]")?.addEventListener("click", async event => {
      const button = event.currentTarget;
      const carrier = shippingPanel.querySelector("[name='detail_shipping_carrier']")?.value || "";
      const tracking = shippingPanel.querySelector("[name='detail_shipping_tracking']")?.value.trim() || "";
      button.disabled = true;
      try {
        await OrdersService.updateStatus(order.id, {
          shipping_carrier: normalizeNullable(carrier),
          shipping_tracking_number: normalizeNullable(tracking),
          updated_by: user.id
        });
        order.shipping_carrier = normalizeNullable(carrier);
        order.shipping_tracking_number = normalizeNullable(tracking);
        setNotice(notice, `Shipping details saved for Order #${order.order_number}.`, "success");
      } catch (error) {
        setNotice(notice, error.message, "error");
      } finally {
        button.disabled = false;
      }
    });

    const labelButton = document.querySelector("#detail-shipping-label");
    if (labelButton) {
      labelButton.hidden = order.fulfillment_method !== "shipping" || order.record_status !== "active";
      labelButton.textContent = order.shipping_label_printed_at ? "Reprint EasyPost Label" : "Buy & Print EasyPost Label";
      labelButton.onclick = () => openShippingLabelSheet(order, {
        userId: user.id,
        onPrinted: async () => {
          await loadOrders();
          closeDialog(dialog);
          showDetail(order.id);
        }
      });
    }

    const edit = document.querySelector("#detail-edit");
    edit.hidden = !(canEdit && order.record_status === "active");
    edit.onclick = () => {
      closeDialog(dialog);
      openOrderEditor(id);
    };

    const voidButton = document.querySelector("#detail-void");
    if (voidButton) {
      const isStorefrontOrder = order.order_source === "online_store";
      voidButton.textContent = isStorefrontOrder ? "Cancel Order" : "Void Order";
      voidButton.hidden = !(canVoid && order.record_status === "active");
      voidButton.onclick = () => {
        closeDialog(dialog);
        openVoid(id);
      };
    }

    const restoreButton = document.querySelector("#detail-restore");
    if (restoreButton) {
      restoreButton.hidden = !(canVoid && order.record_status === "voided");
      restoreButton.onclick = async () => {
        if (!await confirmAction({ title: "Restore Order?", message: `Restore Order #${order.order_number} to Active?`, confirmLabel: "Restore Order" })) return;
        restoreButton.disabled = true;
        try {
          await OrdersService.restoreOrder(id, user.id);
          closeDialog(dialog);
          setNotice(notice, "Order restored to Active. It can now be edited.", "success");
          await loadOrders();
        } catch (error) {
          setNotice(notice, `Order could not be restored: ${error.message}`, "error");
        } finally {
          restoreButton.disabled = false;
        }
      };
    }

    openDialog(dialog);
  }

  async function runWorkflowAction(order, action, button) {
    const updates = { updated_by: user.id };
    if (action === "mark_paid") {
      const cashOrder = order.payment_method === "cash" || order.payment_provider === "cash";
      const venmoOrder = String(order.payment_method || order.payment_provider || "").toLowerCase() === "venmo";
      if (cashOrder && !await confirmAction({
        title: "Confirm Cash Received",
        message: `Confirm you received the full ${money(order.order_total)} cash payment for order #${order.order_number}. This records cash received and marks the order paid; it does not charge a card or transfer funds to PayPal.`,
        confirmLabel: "Record Cash Received"
      })) return;
      if (venmoOrder && !await confirmAction({
        title: "Confirm Venmo Received",
        message: `Confirm the Treasurer received the full ${money(order.order_total)} Venmo payment for order #${order.order_number}. This marks the customer order paid; the Pack checking deposit is tracked separately.`,
        confirmLabel: "Record Venmo Received"
      })) return;
      updates.payment_status = "paid";
      updates.amount_paid = order.order_total;
      if (cashOrder) {
        updates.payment_method = "cash";
        updates.payment_provider = "cash";
      }
      if (venmoOrder) { updates.payment_method = "venmo"; updates.payment_provider = "venmo"; }
      if (order.wholesaler_status === "not_ready") {
        updates.wholesaler_status = "ready_to_submit";
      }
    } else if (action === "ready_roaster") {
      updates.wholesaler_status = "ready_to_submit";
    } else if (action === "submitted") {
      updates.wholesaler_status = "submitted";
    } else if (action === "received") {
      updates.wholesaler_status = "received";
    } else if (action === "ready_pickup") {
      updates.delivery_status = "ready_for_pickup";
    } else if (action === "ready_ship") {
      updates.shipping_status = "ready_to_ship";
    } else if (action === "mark_shipped") {
      const panel = document.querySelector("#detail-content [data-shipping-panel]");
      const carrier = panel?.querySelector("[name='detail_shipping_carrier']")?.value || order.shipping_carrier || "";
      const tracking = panel?.querySelector("[name='detail_shipping_tracking']")?.value.trim() || order.shipping_tracking_number || "";
      if (!carrier || !tracking) {
        setNotice(notice, "Choose a carrier and enter the tracking number before marking this order Shipped.", "error");
        return;
      }
      updates.shipping_status = "shipped";
      updates.shipping_carrier = carrier;
      updates.shipping_tracking_number = tracking;
      updates.shipping_shipped_at = new Date().toISOString();
      updates.delivery_status = "out_for_delivery";
    } else if (action === "shipping_delivered") {
      updates.shipping_status = "delivered";
      updates.shipping_delivered_at = new Date().toISOString();
      updates.delivery_status = "delivered";
    } else if (action === "delivered") {
      updates.delivery_status = "delivered";
    } else {
      return;
    }

    button.disabled = true;
    try {
      if (action === "received") await OrdersService.markAllReceived(order.id, user.id);
      else await OrdersService.updateStatus(order.id, updates);
      closeDialog(document.querySelector("#order-detail-dialog"));
      setNotice(notice, action === "mark_paid" && updates.payment_provider === "cash" ? "Cash received. Order marked paid and ready for the roaster." : "Order status updated.", "success");
      await loadOrders();
      if (action !== "ready_pickup") showDetail(order.id);
    } catch (error) {
      setNotice(notice, error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  function setupVoid() {
    const dialog = document.querySelector("#void-dialog");
    const form = document.querySelector("#void-form");
    const refundButton = document.querySelector("#void-refund");
    dialog.querySelectorAll("[data-close]").forEach(button =>
      button.addEventListener("click", () => closeDialog(dialog)));

    form.addEventListener("submit", async event => {
      event.preventDefault();
      const fd = new FormData(form);
      const id = fd.get("id");
      const reason = String(fd.get("void_reason") || "").trim();
      try {
        await OrdersService.voidOrder(id, reason, user.id);
      } catch (error) {
        setNotice(document.querySelector("#void-notice"), error.message, "error");
        return;
      }
      const order = orders.find(item => item.id === id);
      const isStorefrontOrder = order?.order_source === "online_store";
      closeDialog(dialog);
      setNotice(
        notice,
        isStorefrontOrder
          ? "Order cancelled. Any payment was left unchanged."
          : "Order voided.",
        "success"
      );
      await loadOrders();
    });

    refundButton?.addEventListener("click", async () => {
      if (!form.reportValidity()) return;
      const fd = new FormData(form);
      const id = fd.get("id");
      const reason = String(fd.get("void_reason") || "").trim();
      const order = orders.find(item => item.id === id);
      if (!order) return;

      const amount = Number(order.amount_paid || order.order_total || 0);
      if (!await confirmAction({
        title: "Cancel and Refund Order?",
        message: `Cancel Order #${order.store_order_number || order.order_number} and refund ${money(amount)} through PayPal? This sends money back to the customer.`,
        confirmLabel: "Cancel & Refund",
        urgent: true
      })) return;

      refundButton.disabled = true;
      const cancelOnlyButton = document.querySelector("#void-submit");
      if (cancelOnlyButton) cancelOnlyButton.disabled = true;
      clearNotice(document.querySelector("#void-notice"));

      try {
        const result = await OrdersService.cancelAndRefund(id, reason);
        closeDialog(dialog);
        setNotice(
          notice,
          `Order cancelled and ${money(result.refunded_amount || amount)} refunded through PayPal.`,
          "success"
        );
        await loadOrders();
      } catch (error) {
        setNotice(document.querySelector("#void-notice"), error.message, "error");
      } finally {
        refundButton.disabled = false;
        if (cancelOnlyButton) cancelOnlyButton.disabled = false;
      }
    });
  }

  function openVoid(id) {
    const dialog = document.querySelector("#void-dialog");
    const order = orders.find(item => item.id === id);
    const isStorefrontOrder = order?.order_source === "online_store";

    dialog.querySelector("form").reset();
    dialog.querySelector("[name='id']").value = id;

    document.querySelector("#void-dialog-title").textContent =
      isStorefrontOrder ? "Cancel Order" : "Void Order";

    document.querySelector("#void-dialog-copy").textContent =
      isStorefrontOrder
        ? "Cancelled storefront orders remain in the audit history and no longer count toward active totals or Scout credit."
        : "Voided orders remain in the audit history and no longer count toward active totals or Scout credit.";

    document.querySelector("#void-dialog-reason-label").textContent =
      isStorefrontOrder ? "Reason for cancellation" : "Reason for voiding";

    const cancelOnlyButton = document.querySelector("#void-submit");
    const refundButton = document.querySelector("#void-refund");
    const isPaidPaypalOrder =
      isStorefrontOrder &&
      order?.payment_provider === "paypal" &&
      order?.payment_status === "paid";

    cancelOnlyButton.textContent = isPaidPaypalOrder
      ? "Cancel Order Only"
      : isStorefrontOrder ? "Cancel Order" : "Void Order";

    refundButton.hidden = !isPaidPaypalOrder;
    if (isPaidPaypalOrder) {
      const amount = Number(order.amount_paid || order.order_total || 0);
      refundButton.textContent = `Cancel & Refund ${money(amount)}`;
      document.querySelector("#void-dialog-copy").textContent =
        `This order was paid through PayPal. Cancel Order Only leaves the payment in PayPal. Cancel & Refund returns ${money(amount)} to the customer and cancels the order.`;
    }

    clearNotice(document.querySelector("#void-notice"));
    openDialog(dialog);
  }

  try {
    await loadReferenceData();
    await loadOrders();
    if (pageParams.get("action") === "resume" && canEdit) {
      window.__restoreOrderDraft?.(pageParams.get("customer_id"));
      window.history.replaceState({}, "", "/committee/orders.html");
    } else if (pageParams.get("action") === "new" && canEdit) {
      openOrderEditor();
    }
    const requestedOrder = pageParams.get("order");
    if (requestedOrder && orders.some(order => order.id === requestedOrder)) {
      showDetail(requestedOrder);
    }
  } catch (error) {
    setNotice(notice, error.message, "error");
  }

  function renderFulfillmentCell(order) {
    const method = order.fulfillment_method;
    const eligibility = order.delivery_eligibility;

    if (method === "pickup") {
      return `<span class="delivery-eligibility delivery-eligibility--eligible">Pickup</span><div class="cell-note">No delivery-area check needed</div>`;
    }
    if (method === "shipping") {
      const printed = order.shipping_label_printed_at
        ? `<div class="shipping-label-print-note"><span class="shipping-label-status shipping-label-status--printed">Label Printed</span><span class="cell-note">${escapeHtml(formatLabelPrintDate(order.shipping_label_printed_at))}</span></div>`
        : `<div class="cell-note">Label not printed</div>`;
      return `<span class="delivery-eligibility delivery-eligibility--shipping">Shipping</span>${printed}`;
    }
    if (method !== "local_delivery") {
      return `<span class="delivery-eligibility delivery-eligibility--pending">Not Set</span>`;
    }
    if (!eligibility) return `<span class="delivery-eligibility delivery-eligibility--pending">Local Delivery</span><div class="cell-note">Pending area check</div>`;
    if (eligibility.manual_local_override) {
      return `<span class="delivery-eligibility delivery-eligibility--eligible">Local Delivery</span><div class="cell-note">Exception: ${escapeHtml(eligibility.manual_local_reason || "Approved manually")}</div>`;
    }
    const eligibleMatches = (eligibility.matches || []).filter(item => item.eligible);
    if (eligibility.status === "eligible") {
      const first = eligibleMatches[0];
      const extra = eligibleMatches.length > 1 ? ` +${eligibleMatches.length - 1}` : "";
      return `<span class="delivery-eligibility delivery-eligibility--eligible">Local Delivery</span>${first ? `<div class="cell-note">${escapeHtml(first.driver_name)} · ${escapeHtml(first.route_name)} · ${formatMiles(first.distance_miles)}${extra}</div>` : ""}`;
    }
    if (eligibility.status === "shipping_required") {
      const nearest = (eligibility.matches || [])[0];
      return `<span class="delivery-eligibility delivery-eligibility--warning">Local — Outside Area</span>${nearest ? `<div class="cell-note">Nearest: ${escapeHtml(nearest.route_name)} · ${formatMiles(nearest.distance_miles)}</div>` : ""}`;
    }
    if (eligibility.status === "no_address") return `<span class="delivery-eligibility delivery-eligibility--warning">Local — No Address</span>`;
    if (eligibility.status === "geocode_failed") return `<span class="delivery-eligibility delivery-eligibility--warning">Local — Address Check Failed</span>`;
    if (eligibility.status === "no_active_areas") return `<span class="delivery-eligibility delivery-eligibility--pending">Local — No Active Areas</span>`;
    return `<span class="delivery-eligibility delivery-eligibility--pending">Local Delivery</span><div class="cell-note">Pending area check</div>`;
  }

  function renderDeliveryEligibilityDetail(order) {
    if (order.fulfillment_method === "pickup") {
      return `<section class="delivery-eligibility-panel"><div><h3>Fulfillment</h3><p><strong>Pickup / No Delivery Needed.</strong> This order does not need a route or radius check.</p></div></section>`;
    }
    if (order.fulfillment_method === "shipping") {
      return `<section class="delivery-eligibility-panel"><div><h3>Fulfillment</h3><p><strong>Shipping selected.</strong> This order does not need a local-delivery-area check.</p></div></section>`;
    }
    if (order.fulfillment_method !== "local_delivery") {
      return `<section class="delivery-eligibility-panel"><div><h3>Fulfillment</h3><p><strong>Not selected.</strong> Choose Pickup, Local Delivery, or Shipping when editing this order.</p></div></section>`;
    }

    const eligibility = order.delivery_eligibility;
    if (!eligibility) {
      return `<section class="delivery-eligibility-panel"><div><h3>Delivery Eligibility</h3><p>Pending address check.</p></div></section>`;
    }
    const checked = eligibility.checked_at ? formatDateTime(eligibility.checked_at) : "Not checked";
    const allMatches = eligibility.matches || [];
    const eligibleMatches = allMatches.filter(item => item.eligible);
    let body = "";
    if (eligibility.status === "eligible") {
      body = `<p><strong>Local delivery is available.</strong> ${eligibleMatches.length} delivery area${eligibleMatches.length === 1 ? " matches" : "s match"} this customer.</p>${eligibleMatches.map(match => `<div class="delivery-match-line"><span>${escapeHtml(match.driver_name)} — ${escapeHtml(match.route_name)}</span><strong>${formatMiles(match.distance_miles)}</strong></div>`).join("")}`;
    } else if (eligibility.status === "shipping_required") {
      const nearest = allMatches[0];
      body = `<p><strong>This customer selected Local Delivery, but no active delivery area matches the address.</strong> Add a manual exception if you have a special arrangement, or change the fulfillment method after contacting the customer.</p>${nearest ? `<div class="delivery-match-line"><span>Nearest: ${escapeHtml(nearest.driver_name)} — ${escapeHtml(nearest.route_name)}</span><strong>${formatMiles(nearest.distance_miles)} / ${Number(nearest.allowed_distance_miles).toLocaleString()} mi allowed</strong></div>` : ""}`;
    } else if (eligibility.status === "no_address") {
      body = `<p><strong>No delivery address is available.</strong> Add an address to the customer record before checking local delivery.</p>`;
    } else if (eligibility.status === "geocode_failed") {
      body = `<p><strong>The address could not be located.</strong> ${escapeHtml(eligibility.error_message || "Review the customer address and try again.")}</p>`;
    } else {
      body = `<p><strong>No active delivery areas are configured.</strong></p>`;
    }
    const override = eligibility.manual_local_override
      ? `<div class="delivery-local-exception"><div><strong>Local by Exception</strong><p>${escapeHtml(eligibility.manual_local_reason || "Manual local fulfillment")}</p></div>${isCoffeeBean ? `<button type="button" class="table-action" data-remove-local-override="${order.id}">Remove Exception</button>` : ""}</div>`
      : isCoffeeBean
        ? `<div class="delivery-local-exception delivery-local-exception--available"><div><strong>Need to treat this order as local anyway?</strong><p>Use a manual exception for family pickup, planned visits, or another arrangement outside the normal delivery area.</p></div><button type="button" class="table-action" data-add-local-override="${order.id}">Mark Local by Exception</button></div>`
        : "";
    return `<section class="delivery-eligibility-panel"><div class="delivery-eligibility-panel__heading"><div><h3>Delivery Eligibility</h3><span class="cell-note">Checked ${escapeHtml(checked)}</span></div>${isCoffeeBean ? `<button type="button" class="table-action" data-recheck-order="${order.id}">Recheck</button>` : ""}</div>${body}${override}</section>`;
  }

  function fulfillmentMethodLabel(value) {
    return LABELS.fulfillment_method[value] || "Not Set";
  }

  function deliveryEligibilityText(eligibility) {
    if (!eligibility) return "Pending";
    if (eligibility.manual_local_override) return "Local by Exception";
    if (eligibility.status === "eligible") return "Local Delivery";
    if (eligibility.status === "shipping_required") return "Shipping Required";
    if (eligibility.status === "no_address") return "No Address";
    if (eligibility.status === "geocode_failed") return "Address Check Failed";
    if (eligibility.status === "no_active_areas") return "No Active Areas";
    return "Pending";
  }

  function formatMiles(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return `${number.toFixed(number < 10 ? 2 : 1)} mi`;
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    return date.toLocaleString(undefined, { month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit" });
  }

}

function progressBadge(order) {
  const workflow = order.progress_label
    ? {
        label: order.progress_label,
        tone: order.progress_tone
      }
    : getOrderWorkflow(order);
  return `<span class="progress-badge progress-badge--${workflow.tone}">
    ${escapeHtml(workflow.label)}
  </span>`;
}

function renderWorkflowActions(order) {
  const actions = [];
  if (order.payment_status !== "paid") {
    actions.push(["mark_paid", order.payment_method === "cash" || order.payment_provider === "cash" ? "Record Cash Received" : String(order.payment_method || order.payment_provider || "").toLowerCase() === "venmo" ? "Record Venmo Received" : "Mark Paid"]);
  }
  if (order.payment_status === "paid" && order.wholesaler_status === "not_ready") {
    actions.push(["ready_roaster", "Ready to Order"]);
  }
  if (order.wholesaler_status === "ready_to_submit") {
    actions.push(["submitted", "Mark Ordered"]);
  }
  if (["submitted", "in_process"].includes(order.wholesaler_status)) {
    actions.push(["received", "Coffee Received"]);
  }
  if (order.fulfillment_method === "shipping") {
    if (order.wholesaler_status === "received" && (order.shipping_status || "not_ready") === "not_ready") {
      actions.push(["ready_ship", "Ready to Ship"]);
    }
    if (order.shipping_status === "ready_to_ship") {
      actions.push(["mark_shipped", "Mark Shipped"]);
    }
    if (order.shipping_status === "shipped") {
      actions.push(["shipping_delivered", "Mark Delivered"]);
    }
  } else {
    if (order.wholesaler_status === "received" && order.delivery_status === "not_ready") {
      actions.push(["ready_pickup", "Ready for Pickup"]);
    }
    if (["ready_for_pickup", "out_for_delivery"].includes(order.delivery_status)) {
      actions.push(["delivered", "Mark Delivered"]);
    }
  }
  if (!actions.length) return "";

  return `<section class="workflow-actions" aria-label="Order status actions">
    <h3>Next Actions</h3>
    <div>${actions.map(([key, label]) => `
      <button class="portal-button workflow-action"
              type="button" data-workflow-action="${key}">
        ${label}
      </button>
    `).join("")}</div>
  </section>`;
}

function renderTimeline(order) {
  const isShipping = order.fulfillment_method === "shipping";
  const shippingStatus = order.shipping_status || "not_ready";
  const steps = [
    { label: "Created", complete: true },
    { label: "Paid", complete: order.payment_status === "paid" },
    {
      label: order.wholesaler_status === "partially_ordered" ? "Partially Ordered" : "Ordered",
      complete: ["submitted", "in_process", "received"].includes(order.wholesaler_status)
    },
    { label: "Coffee Received", complete: order.wholesaler_status === "received" },
    isShipping
      ? { label: "Ready to Ship", complete: ["ready_to_ship", "shipped", "delivered"].includes(shippingStatus) }
      : { label: "Ready for Pickup", complete: ["ready_for_pickup", "out_for_delivery", "delivered"].includes(order.delivery_status) },
    isShipping
      ? { label: shippingStatus === "delivered" ? "Delivered" : "Shipped", complete: ["shipped", "delivered"].includes(shippingStatus) }
      : { label: "Delivered", complete: order.delivery_status === "delivered" }
  ];

  let lastComplete = 0;
  steps.forEach((step, index) => {
    if (step.complete) lastComplete = index;
  });

  return `<div class="order-timeline" aria-label="Order progress">
    ${steps.map((step, index) => `
      <div class="timeline-step ${step.complete ? "is-complete" : ""}
                  ${index === lastComplete && !steps.at(-1).complete ? "is-current" : ""}">
        <span class="timeline-dot">${step.complete ? "✓" : index + 1}</span>
        <span>${escapeHtml(step.label)}</span>
      </div>
    `).join("")}
  </div>`;
}

function renderShippingDetail(order, canEdit) {
  if (order.fulfillment_method !== "shipping") return "";
  const address = customerAddress(order.customers || {}) || "No shipping address is on the customer record.";
  const carrier = order.shipping_carrier || "";
  const tracking = order.shipping_tracking_number || "";
  const shipped = order.shipping_shipped_at ? shippingDateTime(order.shipping_shipped_at) : "—";
  const delivered = order.shipping_delivered_at ? shippingDateTime(order.shipping_delivered_at) : "—";
  return `<section class="shipping-order-panel" data-shipping-panel>
    <div class="shipping-order-panel__heading">
      <div><h3>Shipping</h3><p>Ship to <strong>${escapeHtml(address)}</strong></p></div>
      <span class="shipping-workflow-badge">${escapeHtml(LABELS.shipping_status[order.shipping_status] || "Not Ready")}</span>
    </div>
    <div class="shipping-order-fields">
      <label class="form-field"><span>Carrier</span>
        <select name="detail_shipping_carrier" ${canEdit ? "" : "disabled"}>
          ${carrierOptions(carrier)}
        </select>
      </label>
      <label class="form-field"><span>Tracking number</span>
        <input name="detail_shipping_tracking" value="${escapeHtml(tracking)}" ${canEdit ? "" : "readonly"} placeholder="Enter tracking number">
      </label>
    </div>
    <div class="shipping-order-meta"><span>Shipped: <strong>${escapeHtml(shipped)}</strong></span><span>Delivered: <strong>${escapeHtml(delivered)}</strong></span></div>
    ${canEdit ? `<div class="shipping-order-actions"><button type="button" class="table-action" data-save-shipping>Save Shipping Details</button></div>` : ""}
  </section>`;
}

function shippingDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, { month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit" });
}

function carrierOptions(selected = "") {
  const values = [["", "Choose carrier"], ["USPS", "USPS"], ["UPS", "UPS"], ["FedEx", "FedEx"], ["Other", "Other"]];
  return values.map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
}

function extractGrind(notes) {
  const match = String(notes || "").match(/(?:^|\n)\s*Grind\s*:\s*(.+?)(?:\n|$)/i);
  return match ? match[1].trim() : "";
}

function normalizeGrind(value) {
  return String(value || "").trim().toLowerCase() === "whole bean"
    ? "Whole Bean"
    : "Ground";
}

function orderDialog() {
  return `<dialog class="portal-dialog portal-dialog--xwide" id="order-dialog">
    <form method="post" class="dialog-card" id="order-form">
      <div class="dialog-header">
        <h2 id="order-dialog-title">New Order</h2>
        <button type="button" class="icon-button" data-close>×</button>
      </div>
      <input type="hidden" name="id">
      <div class="form-grid">
        <div class="form-field form-field--full autocomplete">
          <span>Customer</span>
          <input name="customer_search" type="search" autocomplete="off"
                 placeholder="Start typing a customer name, email, or phone" required>
          <input name="customer_id" type="hidden">
          <div class="autocomplete-results" id="customer-results" hidden></div>
          <div class="recent-customer-list" id="recent-customers"></div>
        </div>
        <label class="form-field">
          <span>Order date</span>
          <input name="order_date" type="date" required>
        </label>
        <label class="form-field" id="ecwid-order-field">
          <span>Ecwid order number</span>
          <input name="ecwid_order_number">
        </label>
        <label class="form-field" id="storefront-order-field" hidden>
          <span>Storefront order number</span>
          <input name="store_order_number" readonly>
        </label>
        <label class="form-field">
          <span>Payment status</span>
          <select name="payment_status">${options(LABELS.payment_status)}</select>
        </label>
        <label class="form-field">
          <span>Amount paid</span>
          <input name="amount_paid" type="number" min="0" step="0.01" value="0">
        </label>
        <label class="form-field">
          <span>Roaster status</span>
          <select name="wholesaler_status">${options(LABELS.wholesaler_status)}</select>
        </label>
        <label class="form-field">
          <span>Fulfillment</span>
          <select name="fulfillment_method">
            <option value="">Not Set</option>
            ${options(LABELS.fulfillment_method)}
          </select>
        </label>
        <label class="form-field">
          <span>Delivery status</span>
          <select name="delivery_status">${options(LABELS.delivery_status)}</select>
        </label>
        <div class="form-field form-field--full shipping-order-editor" id="shipping-order-fields" hidden>
          <span>Shipping workflow</span>
          <div class="shipping-order-editor__grid">
            <label class="form-field"><span>Shipping status</span><select name="shipping_status">${options(LABELS.shipping_status)}</select></label>
            <label class="form-field"><span>Carrier</span><select name="shipping_carrier">${carrierOptions()}</select></label>
            <label class="form-field"><span>Tracking number</span><input name="shipping_tracking_number" placeholder="Enter tracking number"></label>
          </div>
        </div>
        <label class="form-field">
          <span>Payment method</span>
          <input name="payment_method">
        </label>
        <label class="form-field form-field--full">
          <span>Notes</span>
          <textarea name="notes" rows="2"></textarea>
        </label>
      </div>
      <div class="order-items-heading">
        <h3>Order Items</h3>
        <button type="button" class="portal-button portal-button--secondary"
                id="add-line">Add Line</button>
      </div>
      <div id="order-items" class="order-items"></div>
      <div class="order-totals">
        <div><span>Order Total</span><strong id="order-total">$0.00</strong></div>
        <div><span>Fundraising Credit</span><strong id="order-credit">$0.00</strong></div>
      </div>
      <div id="order-form-notice" class="notice" hidden></div>
      <div class="dialog-actions">
        <button type="button" class="portal-button portal-button--secondary" data-close>Cancel</button>
        <button type="submit" class="portal-button">Save Order</button>
      </div>
    </form>
  </dialog>`;
}

async function printPackingSheets(pageNotice, orders = []) {
  const button = document.querySelector("#print-packing-sheets");
  const original = button?.textContent || "Print Packing Sheets";
  try {
    if (button) { button.disabled = true; button.textContent = "Preparing…"; }

    // Always reload the current order records when printing. This avoids a stale
    // in-memory list after workflow/status changes and guarantees that current
    // order items are available for the packing sheets.
    const currentOrders = await OrdersService.list();

    const packableOrders = (currentOrders || []).filter(order => {
      if ((order.record_status || "active") !== "active") return false;

      const wholesalerStatus = String(order.wholesaler_status || "not_ready").toLowerCase();
      const deliveryStatus = String(order.delivery_status || "not_ready").toLowerCase();
      const shippingStatus = String(order.shipping_status || "not_ready").toLowerCase();

      // Coffee Received is the earliest packing stage. Once an order advances
      // to Ready for Pickup / Out for Delivery (or an equivalent shipping
      // stage), its packing sheet remains available for reprinting even if the
      // roaster status was not kept in sync on an older/manual order.
      const coffeeReceived = wholesalerStatus === "received";
      const pickupInProgress = ["ready_for_pickup", "out_for_delivery"].includes(deliveryStatus);
      const shippingInProgress = ["ready_to_ship", "label_created", "shipped"].includes(shippingStatus);

      if (!coffeeReceived && !pickupInProgress && !shippingInProgress) return false;
      if (deliveryStatus === "delivered" || shippingStatus === "delivered") return false;
      return true;
    });

    const packable = packableOrders.flatMap(order => (order.order_items || []).map(item => ({
      customer_id: order.customer_id || order.customers?.id || null,
      customer_name: order.customer_name || customerName(order.customers),
      address_line_1: order.customers?.address_line_1 || "",
      address_line_2: order.customers?.address_line_2 || "",
      city: order.customers?.city || "",
      state: order.customers?.state || "",
      postal_code: order.customers?.postal_code || "",
      order_id: order.id,
      order_number: order.order_number,
      product_name: item.products?.product_name || "Coffee",
      bag_size: item.products?.bag_size || "",
      grind_label: packingGrindLabel(item.notes),
      scout_name: scoutPlainName(item.scouts || {}),
      scout_is_general_fund: Boolean(item.scouts?.is_general_fund),
      quantity_delivering: Math.max(0, Number(item.quantity || 0)),
      quantity_outstanding: 0,
      exception_reasons: ""
    }))).filter(row => row.quantity_delivering > 0);

    if (!packableOrders.length) {
      setNotice(pageNotice, "No active orders are currently at Coffee Received, Ready for Pickup, Out for Delivery, or a shipping packing stage.", "error");
      return;
    }

    if (!packable.length) {
      const orderNumbers = packableOrders.map(order => `#${order.order_number}`).join(", ");
      setNotice(pageNotice, `Packing-stage orders were found (${orderNumbers}), but they contain no printable order-item quantities.`, "error");
      return;
    }

    const grouped = new Map();
    for (const row of packable) {
      // Keep each order on its own packing sheet. This also makes reprints
      // predictable when one customer has placed more than one order.
      const key = `order:${row.order_id || row.order_number}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }

    document.querySelector("#delivery-print-area").innerHTML = [...grouped.values()].map(renderPackingSheet).join("");
    document.body.classList.remove("printing-shipping-labels");
    document.body.classList.add("printing-delivery-sheets");
    await waitForPackingSheetImages();
    window.print();
    setTimeout(() => document.body.classList.remove("printing-delivery-sheets"), 250);
  } catch (error) {
    setNotice(pageNotice, error.message || "Packing sheets could not be prepared.", "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

function packingGrindLabel(notes) {
  const match = String(notes || "").match(/Grind:\s*([^\n\r]+)/i);
  return match?.[1]?.trim() || "Whole Bean";
}


function renderPackingSheet(items) {
  const first = items[0] || {};
  const delivering = items.filter(i => Number(i.quantity_delivering || 0) > 0);
  const outstanding = items.filter(i => Number(i.quantity_outstanding || 0) > 0);
  const orderNumbers = [...new Set(items.map(i => i.order_number).filter(Boolean).map(n => `#${n}`))].join(", ");
  const scoutThanks = packingScoutThanks(items);
  return `<section class="customer-delivery-sheet"><header class="delivery-sheet-header"><div class="delivery-sheet-brand"><img class="delivery-sheet-logo" src="/images/heritage-coffee-delivery-logo.png" alt="Heritage Coffee"><div><p class="section-eyebrow">Friends of 323 Coffee Fundraiser</p><h1>Packing Sheet</h1></div></div><div class="delivery-sheet-customer"><strong>${escapeHtml(first.customer_name || "Customer")}</strong><br>${packingAddress(first)}</div></header><div class="delivery-sheet-meta">Order(s): ${escapeHtml(orderNumbers || "—")}</div><h2>Pack These Items</h2>${packingTable(delivering)}<h2 class="${outstanding.length ? "outstanding-heading" : ""}">Outstanding Items</h2>${outstanding.length ? packingTable(outstanding, true) : `<p class="delivery-all-complete">No outstanding items.</p>`}${outstanding.length ? `<div class="delivery-outstanding-callout"><strong>${packingSum(outstanding,"quantity_outstanding")} item(s) still outstanding.</strong> Do not include these items in this package.</div>` : ""}<footer>${escapeHtml(scoutThanks)}</footer></section>`;
}

function packingScoutThanks(items) {
  const scoutNames = [...new Set(
    items
      .filter(item => !item.scout_is_general_fund)
      .map(item => String(item.scout_name || "").trim())
      .filter(name => name && name !== "Unknown Scout")
  )];

  if (!scoutNames.length) return "Thank you for supporting Pack 323.";
  if (scoutNames.length === 1) return `Thank you for supporting ${scoutNames[0]} and Pack 323.`;
  const finalName = scoutNames.pop();
  return `Thank you for supporting ${scoutNames.join(", ")} and ${finalName}, and Pack 323.`;
}

async function waitForPackingSheetImages() {
  const images = [...document.querySelectorAll("#delivery-print-area img")];
  await Promise.all(images.map(async image => {
    if (image.complete) return;
    try { await image.decode(); }
    catch {
      await new Promise(resolve => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });
    }
  }));
}
function packingTable(rows, outstanding=false) { if (!rows.length) return `<p class="delivery-all-complete">No items in this section.</p>`; return `<table class="delivery-sheet-table"><thead><tr><th>Item</th><th>Size</th><th>Grind</th><th>Qty</th><th>Note</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.product_name||"")}</td><td>${escapeHtml(r.bag_size||"")}</td><td>${escapeHtml(r.grind_label||"")}</td><td>${Number(outstanding?r.quantity_outstanding:r.quantity_delivering)||0}</td><td>${escapeHtml(outstanding?(r.exception_reasons||"Awaiting roaster receipt"):"")}</td></tr>`).join("")}</tbody></table>`; }
function packingAddress(row) { const lines=[row.address_line_1,row.address_line_2,[row.city,row.state,row.postal_code].filter(Boolean).join(" ")].filter(Boolean); return lines.map(escapeHtml).join("<br>")||"No address on file"; }
function packingSum(rows,key){return rows.reduce((t,r)=>t+Number(r[key]||0),0);}


function ol959wxSelectorMarkup() {
  return `<section class="ol959wx-first-sheet">
    <div class="batch-label-first-sheet-heading">
      <strong>First OL959WX sheet — usable labels</strong>
      <small>Uncheck any 4 × 6 position that has already been used. The sheet feeds from the top.</small>
    </div>
    <div class="label-sheet-selector label-sheet-selector--four label-sheet-selector--ol959wx" aria-label="OL959WX first-sheet available label positions">
      <label class="label-slot-option label-slot-option--top-left">
        <input type="checkbox" data-ol959wx-slot="top-left" checked>
        <span><strong>Top Left</strong><small>Available</small></span>
      </label>
      <label class="label-slot-option label-slot-option--top-right">
        <input type="checkbox" data-ol959wx-slot="top-right" checked>
        <span><strong>Top Right</strong><small>Available</small></span>
      </label>
      <label class="label-slot-option label-slot-option--bottom-left">
        <input type="checkbox" data-ol959wx-slot="bottom-left" checked>
        <span><strong>Bottom Left</strong><small>Available</small></span>
      </label>
      <label class="label-slot-option label-slot-option--bottom-right">
        <input type="checkbox" data-ol959wx-slot="bottom-right" checked>
        <span><strong>Bottom Right</strong><small>Available</small></span>
      </label>
      <div class="label-feed-arrow--sheet" aria-hidden="true"><span>↑</span><strong>FEED</strong></div>
    </div>
  </section>`;
}

function selectedOl959wxSlots(dialog) {
  const preferredOrder = ["top-left", "top-right", "bottom-left", "bottom-right"];
  const selected = new Set([...dialog.querySelectorAll("[data-ol959wx-slot]:checked")].map(input => input.dataset.ol959wxSlot));
  return preferredOrder.filter(slot => selected.has(slot));
}

function buildOl959wxSheets(entries, firstSheetSlots = ["top-left", "top-right", "bottom-left", "bottom-right"]) {
  const slotOrder = ["top-left", "top-right", "bottom-left", "bottom-right"];
  const sheets = [];
  let index = 0;
  if (entries.length) {
    const first = Object.fromEntries(slotOrder.map(slot => [slot, null]));
    for (const slot of firstSheetSlots) {
      if (index >= entries.length) break;
      first[slot] = entries[index++];
    }
    sheets.push(first);
  }
  while (index < entries.length) {
    const sheet = Object.fromEntries(slotOrder.map(slot => [slot, null]));
    for (const slot of slotOrder) {
      if (index >= entries.length) break;
      sheet[slot] = entries[index++];
    }
    sheets.push(sheet);
  }
  return sheets;
}

async function openBatchShippingLabelDialog({ orders, user, loadOrders, pageNotice }) {
  const candidates = orders
    .filter(order => order.fulfillment_method === "shipping" && order.record_status === "active" && order.shipping_status !== "delivered")
    .sort((a, b) => {
      const rank = value => value === "ready_to_ship" ? 0 : value === "shipped" ? 1 : 2;
      return rank(a.shipping_status) - rank(b.shipping_status) || Number(a.order_number || 0) - Number(b.order_number || 0);
    });

  if (!candidates.length) {
    window.alert("There are no active shipping orders available for label printing.");
    return;
  }

  document.querySelector("#batch-shipping-label-dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "batch-shipping-label-dialog";
  dialog.className = "portal-dialog shipping-label-dialog shipping-label-batch-dialog";
  dialog.innerHTML = `
    <div class="dialog-card">
      <div class="dialog-header"><div><h2>Buy & Print EasyPost Labels</h2><p class="cell-note">USPS carrier labels · branded Friends of 323 print frame</p></div><button type="button" class="icon-button" data-close>×</button></div>
      <p>Select the shipping orders to print. If EasyPost postage was already purchased, the existing label is reused. Otherwise, clicking <strong>Buy & Print Selected</strong> purchases the saved EasyPost rate. Production orders purchase real postage; test orders generate test labels.</p>
      <div class="batch-label-order-list">
        ${candidates.map(order => {
          const hasEasyPost = order.shipping_rate_source === "easypost" && order.shipping_easypost_shipment_id && order.shipping_easypost_rate_id;
          const checked = order.shipping_status === "ready_to_ship" && !order.shipping_label_printed_at && hasEasyPost;
          return `<label class="batch-label-order ${!hasEasyPost ? "batch-label-order--disabled" : ""}">
            <input type="checkbox" data-batch-order="${escapeHtml(order.id)}" ${checked ? "checked" : ""} ${!hasEasyPost ? "disabled" : ""}>
            <span><strong>Order #${escapeHtml(order.order_number)} · ${escapeHtml(order.customer_name)}</strong><small>${escapeHtml(LABELS.shipping_status[order.shipping_status] || "Not Ready")} · ${escapeHtml(String(order.shipping_rate_environment || "test").toUpperCase())}${order.shipping_tracking_number ? ` · Tracking ${escapeHtml(order.shipping_tracking_number)}` : ""}${order.shipping_label_printed_at ? ` · Printed ${escapeHtml(formatLabelPrintDate(order.shipping_label_printed_at))}` : ""}${!hasEasyPost ? " · No saved EasyPost rate" : ""}</small></span>
          </label>`;
        }).join("")}
      </div>
      ${ol959wxSelectorMarkup()}
      <div class="notice" data-label-notice hidden></div>
      <div class="dialog-actions"><button class="portal-button portal-button--secondary" type="button" data-close>Cancel</button><button class="portal-button" type="button" data-print-batch>Buy & Print Selected</button></div>
    </div>`;
  document.body.appendChild(dialog);
  dialog.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => { dialog.close(); dialog.remove(); }));

  dialog.querySelector("[data-print-batch]").addEventListener("click", async event => {
    const selectedIds = [...dialog.querySelectorAll("[data-batch-order]:checked")].map(input => input.dataset.batchOrder);
    const selected = selectedIds.map(id => candidates.find(order => order.id === id)).filter(Boolean);
    const notice = dialog.querySelector("[data-label-notice]");
    if (!selected.length) {
      notice.hidden = false; notice.className = "notice notice--error"; notice.textContent = "Select at least one EasyPost shipping order."; return;
    }
    const firstSheetSlots = selectedOl959wxSlots(dialog);
    if (!firstSheetSlots.length) {
      notice.hidden = false; notice.className = "notice notice--error"; notice.textContent = "Select at least one unused position on the first OL959WX sheet."; return;
    }

    const printWindow = window.open("", "_blank", "width=1050,height=1200");
    if (!printWindow) { window.alert("Allow pop-ups for this site to print the shipping labels."); return; }
    printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Preparing EasyPost Labels</title></head><body style="font-family:Arial;padding:2rem"><h2>Preparing shipping labels…</h2><p>This window will print when the EasyPost labels are ready.</p></body></html>`);
    printWindow.document.close();

    event.currentTarget.disabled = true;
    notice.hidden = false; notice.className = "notice"; notice.textContent = `Preparing ${selected.length} EasyPost label${selected.length === 1 ? "" : "s"}…`;
    const labels = [];
    const failures = [];
    for (const order of selected) {
      try {
        notice.textContent = `Order #${order.order_number}: Authenticating…`;
        const label = await OrdersService.getEasyPostShippingLabel(order.id, {
          confirmPurchase:true,
          onProgress: message => { notice.textContent = `Order #${order.order_number}: ${message}`; }
        });
        notice.textContent = `Order #${order.order_number}: Carrier label ready…`;
        labels.push({ order, label });
      } catch (error) {
        failures.push(`Order #${order.order_number}: ${error.message}`);
      }
    }

    if (!labels.length) {
      printWindow.close();
      event.currentTarget.disabled = false;
      notice.className = "notice notice--error";
      notice.textContent = failures.join(" ");
      return;
    }

    try {
      notice.textContent = "Preparing print window…";
      await printEasyPostLabelPages(labels, printWindow, firstSheetSlots);
      notice.textContent = "Saving print status…";
      await OrdersService.markShippingLabelsPrinted(labels.map(entry => entry.order.id), user.id);
      dialog.close(); dialog.remove();
      await loadOrders();
      const extra = failures.length ? ` ${failures.length} label${failures.length === 1 ? "" : "s"} could not be prepared.` : "";
      setNotice(pageNotice, `${labels.length} EasyPost shipping label${labels.length === 1 ? "" : "s"} sent to print.${extra}`, failures.length ? "warning" : "success");
      if (failures.length) window.alert(failures.join("\n"));
    } catch (error) {
      window.alert(`The shipping labels could not be completed: ${error.message}`);
    }
  });
  dialog.showModal();
}

async function openShippingLabelSheet(order, { userId = null, onPrinted = null } = {}) {
  if (order.shipping_rate_source !== "easypost" || !order.shipping_easypost_shipment_id || !order.shipping_easypost_rate_id) {
    window.alert("This order does not have a saved EasyPost shipment and rate, so an EasyPost carrier label cannot be purchased automatically.");
    return;
  }

  document.querySelector("#shipping-label-sheet-dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "shipping-label-sheet-dialog";
  dialog.className = "portal-dialog shipping-label-dialog";
  const environment = String(order.shipping_rate_environment || "test").toLowerCase();
  const isReprint = Boolean(order.shipping_label_printed_at);
  dialog.innerHTML = `
    <div class="dialog-card">
      <div class="dialog-header"><div><h2>${isReprint ? "Reprint EasyPost Label" : "Buy & Print EasyPost Label"}</h2><p class="cell-note">Order #${escapeHtml(order.order_number)} · ${escapeHtml(environment.toUpperCase())} environment</p></div><button type="button" class="icon-button" data-close>×</button></div>
      <p>${isReprint ? "This retrieves the carrier label already purchased from EasyPost. It does not purchase postage again." : (environment === "production" ? "This will purchase real USPS postage from the Friends of 323 EasyPost account if the order does not already have a label." : "This is a test EasyPost order. No real postage will be charged.")} If EasyPost already has postage for this shipment, the existing carrier label is reused.</p>
      <p>Prints on Avery OL959WX: four 4 × 6 labels on an 8.5 × 14 legal sheet. Choose the unused position for this label.</p>
      ${ol959wxSelectorMarkup()}
      <div class="notice" data-label-notice hidden></div>
      <div class="dialog-actions"><button class="portal-button portal-button--secondary" type="button" data-close>Cancel</button><button class="portal-button" type="button" data-print-label>${isReprint ? "Reprint Label" : (environment === "production" ? "Buy Postage & Print" : "Create Test Label & Print")}</button></div>
    </div>`;
  document.body.appendChild(dialog);
  dialog.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => { dialog.close(); dialog.remove(); }));
  dialog.querySelector("[data-print-label]").addEventListener("click", async event => {
    const availableSlots = selectedOl959wxSlots(dialog);
    if (!availableSlots.length) {
      const slotNotice = dialog.querySelector("[data-label-notice]");
      slotNotice.hidden = false;
      slotNotice.className = "notice notice--error";
      slotNotice.textContent = "Select the unused OL959WX position for this label.";
      return;
    }
    const singleSlot = [availableSlots[0]];
    const printWindow = window.open("", "_blank", "width=1050,height=1200");
    if (!printWindow) { window.alert("Allow pop-ups for this site to print the shipping label."); return; }
    printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Preparing EasyPost Label</title></head><body style="font-family:Arial;padding:2rem"><h2>Preparing shipping label…</h2></body></html>`);
    printWindow.document.close();

    const notice = dialog.querySelector("[data-label-notice]");
    event.currentTarget.disabled = true;
    notice.hidden = false; notice.className = "notice"; notice.textContent = "Authenticating…";
    try {
      const label = await OrdersService.getEasyPostShippingLabel(order.id, {
        confirmPurchase:true,
        onProgress: message => { notice.textContent = message; }
      });
      notice.textContent = "Preparing print window…";
      await printEasyPostLabelPages([{ order, label }], printWindow, singleSlot);
      notice.textContent = "Saving print status…";
      await OrdersService.markShippingLabelsPrinted([order.id], userId);
      dialog.close(); dialog.remove();
      await onPrinted?.();
    } catch (error) {
      printWindow.close();
      event.currentTarget.disabled = false;
      notice.className = "notice notice--error";
      notice.textContent = error.message;
    }
  });
  dialog.showModal();
}

function shippingThankYouLine(order) {
  const scoutDisplay = String(order?.scout_display || "").trim();
  if (!scoutDisplay || /^general fund$/i.test(scoutDisplay) || /^pack general fund$/i.test(scoutDisplay)) {
    return "Thank you for supporting Pack 323.";
  }
  return `Thank you for supporting ${scoutDisplay} and Pack 323.`;
}

function easyPostLabelFrameMarkup(order, label) {
  const safe = value => escapeHtml(String(value || ""));
  const logo = `${window.location.origin}/images/heritage-coffee-delivery-logo.png`;
  const thankYou = shippingThankYouLine(order);
  return `<div class="ol959wx-label">
    <header class="ol959wx-label__brand">
      <img src="${safe(logo)}" alt="Heritage Coffee">
      <div><strong>FRIENDS OF PACK 323</strong><span>Coffee Fundraiser</span></div>
    </header>
    <div class="ol959wx-label__carrier"><img src="${safe(label.label_data_url || label.label_url)}" alt="${safe(label.carrier || "USPS")} shipping label for order ${safe(order.order_number)}"></div>
    <footer class="ol959wx-label__footer">
      <div class="ol959wx-label__order"><strong>Order #${safe(order.order_number)}</strong>${label.tracking_code ? `<span>Tracking: ${safe(label.tracking_code)}</span>` : ""}</div>
      <div class="ol959wx-label__thanks">${safe(thankYou)}</div>
    </footer>
  </div>`;
}

function easyPostLabelPrintStyles() {
  return `
    @page { size: legal portrait; margin:0; }
    * { box-sizing:border-box; }
    html,body { margin:0; padding:0; width:8.5in; font-family:Arial,Helvetica,sans-serif; color:#17120f; background:#fff; }
    .ol959wx-sheet { width:8.5in; height:14in; padding:1in .25in; display:grid; grid-template-columns:4in 4in; grid-template-rows:6in 6in; gap:0; page-break-after:always; break-after:page; }
    .ol959wx-sheet:last-child { page-break-after:auto; break-after:auto; }
    .ol959wx-slot { width:4in; height:6in; overflow:hidden; }
    .ol959wx-label { width:4in; height:6in; overflow:hidden; background:#fff; display:grid; grid-template-rows:.56in 4.86in .58in; border:0; }
    .ol959wx-label__brand { display:flex; align-items:center; justify-content:center; gap:.12in; padding:.035in .08in; border-bottom:1px solid #5b5149; overflow:hidden; }
    .ol959wx-label__brand img { width:1.02in; max-height:.45in; object-fit:contain; }
    .ol959wx-label__brand div { min-width:0; display:flex; flex-direction:column; line-height:1.02; white-space:nowrap; }
    .ol959wx-label__brand strong { font-size:10.4pt; letter-spacing:.02em; }
    .ol959wx-label__brand span { margin-top:.02in; font-size:7.5pt; font-weight:700; letter-spacing:.05em; text-transform:uppercase; }
    .ol959wx-label__carrier { width:4in; height:4.86in; display:flex; align-items:center; justify-content:center; overflow:hidden; background:#fff; }
    .ol959wx-label__carrier img { display:block; width:3.24in; height:4.86in; object-fit:contain; }
    .ol959wx-label__footer { border-top:1px solid #5b5149; display:grid; grid-template-columns:1.20in minmax(0,1fr); gap:.06in; align-items:center; padding:.035in .08in; overflow:hidden; }
    .ol959wx-label__order { min-width:0; display:flex; flex-direction:column; font-size:6.2pt; line-height:1.06; }
    .ol959wx-label__order strong { font-size:8pt; }
    .ol959wx-label__order span { margin-top:.015in; overflow-wrap:anywhere; font-size:5.25pt; }
    .ol959wx-label__thanks { min-width:0; text-align:right; font-size:8.1pt; line-height:1.08; font-weight:700; overflow-wrap:anywhere; }
    @media screen { body { background:#d9d9d9; width:auto; } .ol959wx-sheet { margin:18px auto; background:#fff; box-shadow:0 2px 14px #777; } }
  `;
}

async function printEasyPostLabelPages(entries, printWindow, firstSheetSlots = ["top-left", "top-right", "bottom-left", "bottom-right"]) {
  const sheets = buildOl959wxSheets(entries, firstSheetSlots);
  const pages = sheets.map(sheet => `<section class="ol959wx-sheet">
    <div class="ol959wx-slot">${sheet["top-left"] ? easyPostLabelFrameMarkup(sheet["top-left"].order, sheet["top-left"].label) : ""}</div>
    <div class="ol959wx-slot">${sheet["top-right"] ? easyPostLabelFrameMarkup(sheet["top-right"].order, sheet["top-right"].label) : ""}</div>
    <div class="ol959wx-slot">${sheet["bottom-left"] ? easyPostLabelFrameMarkup(sheet["bottom-left"].order, sheet["bottom-left"].label) : ""}</div>
    <div class="ol959wx-slot">${sheet["bottom-right"] ? easyPostLabelFrameMarkup(sheet["bottom-right"].order, sheet["bottom-right"].label) : ""}</div>
  </section>`).join("");
  printWindow.document.open();
  printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Friends of 323 EasyPost Shipping Labels</title><style>${easyPostLabelPrintStyles()}</style></head><body>${pages}</body></html>`);
  printWindow.document.close();

  const waitForImages = () => new Promise((resolve, reject) => {
    const images = [...printWindow.document.images];
    if (!images.length) return reject(new Error("The shipping-label print page did not contain a carrier-label image."));
    let remaining = images.length;
    let failed = false;
    const timer = setTimeout(() => {
      if (!failed) {
        failed = true;
        reject(new Error("Carrier label could not be loaded for printing within 8 seconds."));
      }
    }, 8000);
    const finishOne = ok => {
      if (failed) return;
      if (!ok) {
        failed = true;
        clearTimeout(timer);
        reject(new Error("Carrier label image could not be loaded for printing."));
        return;
      }
      remaining -= 1;
      if (remaining === 0) {
        clearTimeout(timer);
        resolve();
      }
    };
    images.forEach(img => {
      if (img.complete) finishOne(img.naturalWidth > 0);
      else {
        img.addEventListener("load", () => finishOne(true), { once:true });
        img.addEventListener("error", () => finishOne(false), { once:true });
      }
    });
  });

  await waitForImages();
  await new Promise(resolve => setTimeout(resolve, 200));
  printWindow.focus();
  printWindow.print();
}

function detailDialog(canVoid) {
  return `<dialog class="portal-dialog portal-dialog--xwide" id="order-detail-dialog">
    <div class="dialog-card">
      <div class="dialog-header">
        <h2 id="detail-title">Order</h2>
        <button type="button" class="icon-button" id="detail-close">×</button>
      </div>
      <div id="detail-content"></div>
      <div class="dialog-actions">
        ${canVoid
          ? `<button type="button" class="portal-button portal-button--secondary"
                     id="detail-restore" hidden>Restore Order</button>
             <button type="button" class="portal-button danger-button"
                     id="detail-void">Void Order</button>`
          : ""}
        <button type="button" class="portal-button portal-button--secondary"
                id="detail-shipping-label" hidden>Buy & Print Shipping Label</button>
        <button type="button" class="portal-button portal-button--secondary"
                id="detail-edit">Edit Order</button>
      </div>
    </div>
  </dialog>`;
}

function voidDialog() {
  return `<dialog class="portal-dialog" id="void-dialog">
    <form method="post" class="dialog-card" id="void-form">
      <div class="dialog-header">
        <h2 id="void-dialog-title">Void Order</h2>
        <button type="button" class="icon-button" data-close>×</button>
      </div>
      <input type="hidden" name="id">
      <p id="void-dialog-copy">Voided orders remain in the audit history and no longer count toward active totals or Scout credit.</p>
      <label class="form-field">
        <span id="void-dialog-reason-label">Reason for voiding</span>
        <textarea name="void_reason" rows="4" required></textarea>
      </label>
      <div id="void-notice" class="notice" hidden></div>
      <div class="dialog-actions">
        <button type="button" class="portal-button portal-button--secondary" data-close>Back</button>
        <button type="submit" class="portal-button danger-button" id="void-submit">Void Order</button>
        <button type="button" class="portal-button danger-button" id="void-refund" hidden>Cancel & Refund</button>
      </div>
    </form>
  </dialog>`;
}

function options(map) {
  return Object.entries(map)
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
}

function fillSelect(select, items, placeholder) {
  select.innerHTML = `<option value="">${placeholder}</option>${
    items.map(item => `<option value="${item.value}">${escapeHtml(item.label)}</option>`).join("")
  }`;
}


function normalizeMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeSku(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/^#/, "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeBagSize(value) {
  const clean = String(value || "").toLowerCase().replace(/\s+/g, "");
  const ounces = clean.match(/(\d+(?:\.\d+)?)\s*(?:oz|ounce|ounces)?/)?.[1];
  return ounces ? `${ounces}oz` : clean;
}

function findImportedProduct(products, imported) {
  const importedSku = normalizeSku(imported?.sku);
  const importedSize = normalizeBagSize(imported?.size);
  const sizeNumber = importedSize.match(/^(\d+(?:\.\d+)?)oz$/)?.[1] || "";
  const importedName = normalizeMatchText(imported?.product_name);

  const candidates = (products || []).filter(product => product.is_active !== false);

  const scored = candidates.map(product => {
    const productSku = normalizeSku(product.sku);
    const productSize = normalizeBagSize(product.bag_size);
    const productName = normalizeMatchText(product.product_name);
    let score = 0;

    if (productSize && importedSize && productSize === importedSize) score += 25;
    if (productSku === importedSku) score += 100;
    if (sizeNumber && productSku === `${importedSku}-${sizeNumber}`) score += 130;
    if (importedSku && productSku.startsWith(`${importedSku}-`) && productSize === importedSize) score += 110;
    if (importedName && productName === importedName) score += 60;
    else if (importedName && (productName.includes(importedName) || importedName.includes(productName))) score += 35;

    return { product, score };
  }).sort((a, b) => b.score - a.score);

  if (!scored.length || scored[0].score < 60) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].product;
}

function findImportedScout(scouts, importedName, orderComments = "") {
  const requested = normalizeMatchText(importedName);
  if (!requested) return null;

  const active = (scouts || []).filter(scout => scout.is_active);
  if (/^(general|general fund|pack|pack 323)$/.test(requested)) {
    return active.find(scout => scout.is_general_fund) || null;
  }

  const exact = active.filter(scout =>
    normalizeMatchText(scoutPlainName(scout)) === requested
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    // Duplicate-name records occasionally exist. Prefer the active record that
    // is actually assigned to a den rather than declaring the import unmatched.
    const withDen = exact.filter(scout => scout.den_id || scout.dens?.den_number);
    if (withDen.length === 1) return withDen[0];
  }

  const requestedParts = requested.split(" ").filter(Boolean);
  let candidates = active.filter(scout => !scout.is_general_fund);

  if (requestedParts.length === 1) {
    candidates = candidates.filter(scout =>
      normalizeMatchText(scout.first_name) === requestedParts[0]
    );
  } else {
    candidates = candidates.filter(scout => {
      const plain = normalizeMatchText(scoutPlainName(scout));
      return requestedParts.every(part => plain.split(" ").includes(part));
    });
  }

  if (candidates.length === 1) return candidates[0];

  if (candidates.length > 1) {
    const withDen = candidates.filter(scout => scout.den_id || scout.dens?.den_number);
    if (withDen.length === 1) return withDen[0];
  }

  if (candidates.length > 1 && orderComments) {
    const commentText = ` ${normalizeMatchText(orderComments)} `;
    const byFamilyName = candidates.filter(scout => {
      const last = normalizeMatchText(scout.last_name);
      return last && commentText.includes(` ${last} `);
    });
    if (byFamilyName.length === 1) return byFamilyName[0];
  }

  return null;
}

function scoutPlainName(scout) {
  if (scout?.is_general_fund) return "General Fund";
  return [scout?.first_name, scout?.last_name].filter(Boolean).join(" ") || "Unknown Scout";
}

function scoutDenLabel(scout) {
  if (scout?.is_general_fund) return "Pack General Fund";
  return scout?.dens?.den_number
    ? `Den ${scout.dens.den_number} · ${scout.dens.current_rank_working_toward || ""}`.replace(/\s+·\s*$/, "")
    : "No den assigned";
}

function productLabel(product) {
  return `${product.product_name} — ${product.bag_size}`;
}

function formatPhoneNumber(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  if (digits.length !== 10) return String(value || "");
  return `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function customerName(customer) {
  const person = [customer?.first_name, customer?.last_name].filter(Boolean).join(" ");
  return person || customer?.company_name || "Unnamed Customer";
}

function scoutName(scout) {
  if (scout?.is_general_fund) return "General Fund";
  return `${scoutPlainName(scout)} — ${scoutDenLabel(scout)}`;
}

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(Number(value || 0));
}

function formatLabelPrintDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit" }).format(date);
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US");
}

function badge(label, status) {
  const cssClass = ["paid", "received", "delivered", "active"].includes(status)
    ? "status-badge--active"
    : ["voided", "refunded"].includes(status)
      ? "status-badge--danger"
      : ["unpaid", "not_ready"].includes(status)
        ? "status-badge--inactive"
        : "status-badge--info";
  return `<span class="status-badge ${cssClass}">${escapeHtml(label || status)}</span>`;
}

function denFilterOptions(profile) {
  if (profile.role === "barista" && profile.den_id) {
    return [
      { value: "all", label: "All Scouts" },
      { value: profile.den_id, label: "My Den" }
    ];
  }
  return [{ value: "all", label: "All Dens" }];
}

function populateDenFilter(grid, scouts, profile) {
  const select = grid.container.querySelector('[data-filter="den"]');
  if (!select || profile.role === "barista") return;
  const dens = new Map();
  for (const scout of scouts || []) {
    if (scout.den_id && scout.dens?.den_number) {
      dens.set(scout.den_id, `Den ${scout.dens.den_number} · ${scout.dens.current_rank_working_toward}`);
    }
  }
  select.innerHTML = '<option value="all">All Dens</option>' +
    [...dens.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }))
      .map(([id, label]) => `<option value="${id}">${escapeHtml(label)}</option>`).join('');


}
