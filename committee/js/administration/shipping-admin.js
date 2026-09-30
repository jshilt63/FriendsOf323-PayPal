import { escapeHtml } from "../components/layout.js?v=1.9.0";
import { AdministrationService } from "../services/administration-service.js?v=1.9.8";
import { confirmAction } from "../components/confirm-dialog.js?v=1.9.4";
import { clearNotice, closeDialog, openDialog, setFormBusy, setNotice } from "../master-data/shared.js";

function money(value) {
  if (value == null || value === "") return "—";
  return new Intl.NumberFormat("en-US", { style:"currency", currency:"USD" }).format(Number(value));
}

function rangeLabel(rate) {
  return rate.max_bags == null
    ? `${rate.min_bags}+ bags`
    : rate.min_bags === rate.max_bags
      ? `${rate.min_bags} bag${rate.min_bags === 1 ? "" : "s"}`
      : `${rate.min_bags}–${rate.max_bags} bags`;
}

function dimensions(rate) {
  const values = [rate.package_length_inches, rate.package_width_inches, rate.package_height_inches];
  if (values.some(value => value == null || value === "")) return "Not entered";
  return `${values.map(Number).join(" × ")} in`;
}

function optionalNumber(value) {
  const text = String(value ?? "").trim();
  return text === "" ? null : Number(text);
}

export function shippingPanelMarkup() {
  return `
    <section id="shipping-panel" class="admin-panel" hidden>
      <div class="shipping-enable-card">
        <div>
          <h2 class="admin-section-title">Storefront Shipping</h2>
          <p class="cell-note">Turn shipping on only when you are ready to accept shipped orders.</p>
        </div>
        <label class="shipping-enable-toggle">
          <input id="shipping-enabled" type="checkbox">
          <span>Enable shipping at checkout</span>
        </label>
      </div>
      <div id="shipping-setting-status" class="shipping-setting-status" aria-live="polite"></div>
      <div class="shipping-return-card">
        <div>
          <h2 class="admin-section-title">Shipping Charge</h2>
          <p class="cell-note">Customers pay the EasyPost USPS Ground Advantage account rate plus this packaging charge. Checkout will not silently substitute a fixed fallback rate if EasyPost cannot return a quote.</p>
        </div>
        <form id="shipping-packaging-form" class="portal-form">
          <div class="form-grid">
            <label class="form-field"><span>Packaging charge</span><input name="shipping_packaging_charge" type="number" min="0" step="0.01" value="2.00" required></label>
          </div>
          <div class="dialog-actions"><button class="portal-button" type="submit">Save Packaging Charge</button></div>
        </form>
      </div>
      <div class="shipping-return-card">
        <div>
          <h2 class="admin-section-title">Shipping Label Return Address</h2>
          <p class="cell-note">Printed in the upper-left corner of the 4 × 6 Heritage Coffee address label.</p>
        </div>
        <form id="shipping-return-form" class="portal-form">
          <div class="form-grid">
            <label class="form-field form-field--wide"><span>Return name</span><input name="shipping_return_name" placeholder="Friends of 323"></label>
            <label class="form-field form-field--wide"><span>Address</span><input name="shipping_return_address_line_1"></label>
            <label class="form-field form-field--wide"><span>Address line 2</span><input name="shipping_return_address_line_2"></label>
            <label class="form-field"><span>City</span><input name="shipping_return_city"></label>
            <label class="form-field"><span>State</span><input name="shipping_return_state" maxlength="2"></label>
            <label class="form-field"><span>ZIP code</span><input name="shipping_return_postal_code"></label>
          </div>
          <div class="dialog-actions"><button class="portal-button" type="submit">Save Return Address</button></div>
        </form>
      </div>
      <div class="shipping-return-card">
        <div>
          <h2 class="admin-section-title">EasyPost Rate Test</h2>
          <p class="cell-note">Test the Netlify EasyPost connection without changing an order. The customer charge shown is the EasyPost USPS Ground Advantage account rate plus the configured packaging charge.</p>
        </div>
        <form id="easypost-test-form" class="portal-form">
          <div class="form-grid">
            <label class="form-field form-field--wide"><span>Shipping package</span><select name="package_id" required><option value="">Choose a package</option></select></label>
            <label class="form-field"><span>Destination ZIP</span><input name="destination_zip" inputmode="numeric" autocomplete="postal-code" maxlength="10" placeholder="64134" required></label>
            <label class="form-field"><span>Coffee contents weight (oz)</span><input name="contents_weight_ounces" type="number" min="0" step="0.1" value="12" required></label>
          </div>
          <div class="dialog-actions"><button class="portal-button portal-button--secondary" type="submit">Test EasyPost Rate</button></div>
          <div id="easypost-test-result" class="shipping-setting-status" aria-live="polite"></div>
        </form>
      </div>
      <div class="audit-toolbar shipping-rates-heading">
        <div>
          <h2 class="admin-section-title">Shipping Packages</h2>
          <p class="cell-note">Match each bag-count range to the box used for shipping. Dimensions and empty-box weight feed the EasyPost USPS Ground Advantage calculator.</p>
        </div>
        <button class="portal-button" id="add-shipping-rate" type="button">Add Package</button>
      </div>
      <div id="shipping-rate-list" class="shipping-rate-list"></div>
    </section>`;
}

export function shippingDialogMarkup() {
  return `
  <dialog id="shipping-rate-dialog" class="portal-dialog">
    <form id="shipping-rate-form" class="portal-form" method="dialog">
      <div class="dialog-heading">
        <div><h2 id="shipping-rate-title">Add Shipping Package</h2><p>Set the bag-count range and physical package information used for EasyPost USPS rating.</p></div>
        <button type="button" class="dialog-close" data-close aria-label="Close">×</button>
      </div>
      <div id="shipping-rate-notice" class="notice" hidden></div>
      <input type="hidden" name="id">
      <div class="form-grid">
        <label class="form-field form-field--wide"><span>Package name</span><input name="label" required maxlength="80" placeholder="Small Box"></label>
        <label class="form-field"><span>Minimum bags</span><input name="min_bags" type="number" min="1" step="1" required></label>
        <label class="form-field"><span>Maximum bags</span><input name="max_bags" type="number" min="1" step="1" placeholder="Leave blank for no maximum"></label>
        <label class="form-field"><span>Length (inches)</span><input name="package_length_inches" type="number" min="0.01" step="0.01" placeholder="Enter after measuring box"></label>
        <label class="form-field"><span>Width (inches)</span><input name="package_width_inches" type="number" min="0.01" step="0.01" placeholder="Enter after measuring box"></label>
        <label class="form-field"><span>Height (inches)</span><input name="package_height_inches" type="number" min="0.01" step="0.01" placeholder="Enter after measuring box"></label>
        <label class="form-field"><span>Empty package weight (oz)</span><input name="package_weight_ounces" type="number" min="0" step="0.01" placeholder="Box + packing material"></label>
        <label class="form-field"><span>Legacy fallback shipping charge</span><input name="rate_amount" type="number" min="0" step="0.01" placeholder="Optional"></label>
        <label class="form-check"><input name="is_active" type="checkbox" checked><span>Enabled</span></label>
      </div>
      <p class="cell-note">Dimensions and empty-box weight are required for EasyPost checkout rating. The legacy fallback value is retained for old data but is not used when EasyPost rating is enabled. Enabled bag-count ranges cannot overlap.</p>
      <div class="dialog-actions">
        <button type="button" class="portal-button danger-button" id="delete-shipping-rate" hidden>Delete Package</button>
        <button type="button" class="portal-button portal-button--secondary" data-close>Cancel</button>
        <button type="submit" class="portal-button">Save Package</button>
      </div>
    </form>
  </dialog>`;
}

export function initializeShippingAdmin({ notice }) {
  const list = document.querySelector("#shipping-rate-list");
  const dialog = document.querySelector("#shipping-rate-dialog");
  const form = document.querySelector("#shipping-rate-form");
  const formNotice = document.querySelector("#shipping-rate-notice");
  let rates = [];
  let settings = { shipping_enabled:false };
  const enabledInput = document.querySelector("#shipping-enabled");
  const settingStatus = document.querySelector("#shipping-setting-status");
  const returnForm = document.querySelector("#shipping-return-form");
  const packagingForm = document.querySelector("#shipping-packaging-form");
  const deleteButton = document.querySelector("#delete-shipping-rate");
  const easypostTestForm = document.querySelector("#easypost-test-form");
  const easypostTestResult = document.querySelector("#easypost-test-result");

  function renderSettings() {
    enabledInput.checked = Boolean(settings.shipping_enabled);
    settingStatus.className = `shipping-setting-status ${settings.shipping_enabled ? "is-enabled" : "is-disabled"}`;
    settingStatus.textContent = settings.shipping_enabled
      ? "Shipping is available at checkout. EasyPost must return the USPS Ground Advantage rate; checkout will stop with an error rather than silently use a fixed fallback charge."
      : "Shipping is currently hidden from checkout. Pickup and local delivery remain available.";
    if (packagingForm?.elements.shipping_packaging_charge) {
      packagingForm.elements.shipping_packaging_charge.value = Number(settings.shipping_packaging_charge ?? 2).toFixed(2);
    }
    for (const name of ["shipping_return_name","shipping_return_address_line_1","shipping_return_address_line_2","shipping_return_city","shipping_return_state","shipping_return_postal_code"]) {
      if (returnForm?.elements[name]) returnForm.elements[name].value = settings[name] || "";
    }
  }

  function render() {
    if (!rates.length) {
      list.innerHTML = `<div class="empty-state"><strong>No shipping packages configured.</strong><p>Add package rows now; box dimensions and weights can be filled in after you measure them.</p></div>`;
      return;
    }
    list.innerHTML = `
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Bag Count</th><th>Package</th><th>Dimensions</th><th>Empty Wt.</th><th>Fallback</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rates.map(rate => `<tr>
          <td><strong>${escapeHtml(rangeLabel(rate))}</strong></td>
          <td>${escapeHtml(rate.label)}</td>
          <td>${escapeHtml(dimensions(rate))}</td>
          <td>${escapeHtml(rate.package_weight_ounces == null ? "—" : `${Number(rate.package_weight_ounces)} oz`)}</td>
          <td>${escapeHtml(money(rate.rate_amount))}</td>
          <td><span class="status-badge ${rate.is_active ? "status-badge--active" : "status-badge--inactive"}">${rate.is_active ? "Enabled" : "Disabled"}</span></td>
          <td><button class="table-action" type="button" data-edit-shipping-rate="${rate.id}">Edit</button></td>
        </tr>`).join("")}</tbody>
      </table></div>`;
  }

  function renderEasyPostPackages() {
    const select = easypostTestForm?.elements.package_id;
    if (!select) return;
    const current = select.value;
    select.innerHTML = `<option value="">Choose a package</option>${rates.map(rate => `<option value="${escapeHtml(rate.id)}">${escapeHtml(rangeLabel(rate))} — ${escapeHtml(rate.label)}</option>`).join("")}`;
    if ([...select.options].some(option => option.value === current)) select.value = current;
  }

  async function load() {
    [settings, rates] = await Promise.all([
      AdministrationService.getShippingSettings(),
      AdministrationService.listShippingRates()
    ]);
    renderSettings();
    render();
    renderEasyPostPackages();
  }

  function edit(rate = null) {
    form.reset();
    clearNotice(formNotice);
    form.elements.id.value = rate?.id || "";
    form.elements.label.value = rate?.label || "";
    form.elements.min_bags.value = rate?.min_bags ?? "";
    form.elements.max_bags.value = rate?.max_bags ?? "";
    form.elements.package_length_inches.value = rate?.package_length_inches ?? "";
    form.elements.package_width_inches.value = rate?.package_width_inches ?? "";
    form.elements.package_height_inches.value = rate?.package_height_inches ?? "";
    form.elements.package_weight_ounces.value = rate?.package_weight_ounces ?? "";
    form.elements.rate_amount.value = rate?.rate_amount ?? "";
    form.elements.is_active.checked = rate?.is_active ?? true;
    document.querySelector("#shipping-rate-title").textContent = rate ? "Edit Shipping Package" : "Add Shipping Package";
    if (deleteButton) deleteButton.hidden = !rate;
    openDialog(dialog);
  }

  enabledInput.addEventListener("change", async () => {
    const nextValue = enabledInput.checked;
    enabledInput.disabled = true;
    settingStatus.className = "shipping-setting-status";
    settingStatus.textContent = "Saving shipping setting…";
    try {
      settings = await AdministrationService.saveShippingSettings({ shipping_enabled:nextValue });
      renderSettings();
      setNotice(notice, nextValue ? "Shipping enabled for checkout." : "Shipping disabled for checkout.", "success");
    } catch (error) {
      enabledInput.checked = !nextValue;
      setNotice(notice, error.message, "error");
      renderSettings();
    } finally {
      enabledInput.disabled = false;
    }
  });


  packagingForm?.addEventListener("submit", async event => {
    event.preventDefault();
    const value = Number(packagingForm.elements.shipping_packaging_charge.value || 0);
    if (!Number.isFinite(value) || value < 0) {
      setNotice(notice, "Packaging charge must be zero or greater.", "error");
      return;
    }
    try {
      settings = await AdministrationService.saveShippingSettings({ shipping_packaging_charge:value });
      renderSettings();
      setNotice(notice, `Packaging charge saved at ${money(value)}.`, "success");
    } catch (error) { setNotice(notice, error.message, "error"); }
  });

  returnForm?.addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(returnForm);
    try {
      settings = await AdministrationService.saveShippingSettings({
        ...settings,
        shipping_enabled:settings.shipping_enabled,
        shipping_return_name:String(data.get("shipping_return_name") || "").trim() || null,
        shipping_return_address_line_1:String(data.get("shipping_return_address_line_1") || "").trim() || null,
        shipping_return_address_line_2:String(data.get("shipping_return_address_line_2") || "").trim() || null,
        shipping_return_city:String(data.get("shipping_return_city") || "").trim() || null,
        shipping_return_state:String(data.get("shipping_return_state") || "").trim().toUpperCase() || null,
        shipping_return_postal_code:String(data.get("shipping_return_postal_code") || "").trim() || null
      });
      renderSettings();
      setNotice(notice, "Shipping-label return address saved.", "success");
    } catch (error) { setNotice(notice, error.message, "error"); }
  });

  easypostTestForm?.addEventListener("submit", async event => {
    event.preventDefault();
    const button = easypostTestForm.querySelector('button[type="submit"]');
    const data = new FormData(easypostTestForm);
    if (button) button.disabled = true;
    easypostTestResult.className = "shipping-setting-status";
    easypostTestResult.textContent = "Requesting USPS Ground Advantage rate from EasyPost…";
    try {
      const response = await fetch("/.netlify/functions/easypost-shipping-test", {
        method:"POST",
        headers:{ "Content-Type":"application/json", Accept:"application/json" },
        body:JSON.stringify({
          package_id:String(data.get("package_id") || ""),
          destination_zip:String(data.get("destination_zip") || "").trim(),
          contents_weight_ounces:Number(data.get("contents_weight_ounces") || 0)
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "EasyPost test failed.");
      const q = result.quote || {};
      easypostTestResult.className = "shipping-setting-status is-enabled";
      easypostTestResult.innerHTML = `<strong>Customer shipping charge: ${escapeHtml(money(result.customer_amount))}</strong> · EasyPost account postage ${escapeHtml(money(result.postage_amount))} + packaging ${escapeHtml(money(result.packaging_charge))} · USPS retail comparison ${escapeHtml(money(q.retail_rate))} · ${escapeHtml(result.parcel?.weight ?? "—")} oz package${q.delivery_days ? ` · about ${escapeHtml(q.delivery_days)} day${Number(q.delivery_days) === 1 ? "" : "s"}` : ""} · ${escapeHtml(q.environment || "test")} environment`;
    } catch (error) {
      easypostTestResult.className = "shipping-setting-status is-disabled";
      easypostTestResult.textContent = error.message || "EasyPost test failed.";
    } finally {
      if (button) button.disabled = false;
    }
  });

  deleteButton?.addEventListener("click", async () => {
    const rateId = String(form.elements.id.value || "");
    const rate = rates.find(item => item.id === rateId);
    if (!rate) return;
    if (!await confirmAction({
      title:"Delete Shipping Package?",
      message:`Delete “${rate.label}” (${rangeLabel(rate)})? Existing orders will keep their saved shipping information, but this package will no longer be available for future quotes.`,
      confirmLabel:"Delete Package",
      urgent:true
    })) return;
    try {
      await AdministrationService.deleteShippingRate(rateId);
      closeDialog(dialog);
      setNotice(notice, "Shipping package deleted.", "success");
      await load();
    } catch (error) {
      setNotice(formNotice, error.message, "error");
    }
  });

  document.querySelector("#add-shipping-rate").addEventListener("click", () => edit());
  dialog.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => closeDialog(dialog)));
  list.addEventListener("click", event => {
    const button = event.target.closest("[data-edit-shipping-rate]");
    if (!button) return;
    edit(rates.find(rate => rate.id === button.dataset.editShippingRate));
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    clearNotice(formNotice);
    const data = new FormData(form);
    const min = Number(data.get("min_bags"));
    const max = optionalNumber(data.get("max_bags"));
    if (max != null && max < min) {
      setNotice(formNotice, "Maximum bags cannot be less than minimum bags.", "error");
      return;
    }
    setFormBusy(form, true);
    try {
      await AdministrationService.saveShippingRate(String(data.get("id") || "") || null, {
        label: String(data.get("label") || "").trim(),
        min_bags: min,
        max_bags: max,
        package_length_inches: optionalNumber(data.get("package_length_inches")),
        package_width_inches: optionalNumber(data.get("package_width_inches")),
        package_height_inches: optionalNumber(data.get("package_height_inches")),
        package_weight_ounces: optionalNumber(data.get("package_weight_ounces")),
        rate_amount: optionalNumber(data.get("rate_amount")),
        is_active: data.get("is_active") === "on"
      });
      closeDialog(dialog);
      setNotice(notice, "Shipping package saved.", "success");
      await load();
    } catch (error) {
      setNotice(formNotice, error.message, "error");
    } finally {
      setFormBusy(form, false);
    }
  });

  return { load };
}
