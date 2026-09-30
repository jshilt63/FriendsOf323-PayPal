import { escapeHtml } from "../components/layout.js?v=1.9.0";
import { AdministrationService } from "../services/administration-service.js";
import { parseRouteFile } from "./route-importer.js";
import { clearNotice, closeDialog, openDialog, setFormBusy, setNotice } from "../master-data/shared.js";
import { confirmAction } from "../components/confirm-dialog.js?v=1.9.4";

const ROUTE_TYPE_LABELS = {
  normal_commute: "Normal commute",
  pack_meeting: "Pack meeting",
  other: "Other"
};

const COVERAGE_LABELS = {
  path: "Route Path",
  radius: "Point / Radius"
};

export function driversPanelMarkup() {
  return `
    <section id="drivers-panel" class="admin-panel" hidden>
      <div class="drivers-toolbar">
        <div>
          <h2>Delivery Drivers</h2>
          <p class="cell-note">Define imported travel routes or point/radius delivery areas, then compare customer addresses against them.</p>
        </div>
        <button class="portal-button" id="add-driver" type="button">Add Driver</button>
      </div>
      <div id="drivers-list" class="drivers-list"></div>
    </section>`;
}

export function driverDialogsMarkup() {
  return `${driverDialog()}${routeDialog()}${routePreviewDialog()}${customerMatchDialog()}`;
}

export async function initializeDriversAdmin({ notice }) {
  const list = document.querySelector("#drivers-list");
  const driverModal = document.querySelector("#driver-dialog");
  const driverForm = document.querySelector("#driver-form");
  const driverNotice = document.querySelector("#driver-form-notice");
  const routeModal = document.querySelector("#route-dialog");
  const routeForm = document.querySelector("#route-form");
  const routeNotice = document.querySelector("#route-form-notice");
  const routeFileHelp = document.querySelector("#route-file-help");
  const previewModal = document.querySelector("#route-preview-dialog");
  const matchModal = document.querySelector("#customer-match-dialog");
  let drivers = [];
  let editingDriverId = null;
  let editingRouteId = null;

  [driverModal, routeModal, previewModal, matchModal].forEach(dialog => {
    dialog.querySelectorAll("[data-close]").forEach(button =>
      button.addEventListener("click", () => closeDialog(dialog)));
  });

  document.querySelector("#add-driver").addEventListener("click", () => {
    editingDriverId = null;
    driverForm.reset();
    driverForm.elements.is_active.checked = true;
    document.querySelector("#driver-dialog-title").textContent = "Add Delivery Driver";
    document.querySelector("#delete-driver").hidden = true;
    clearNotice(driverNotice);
    openDialog(driverModal);
  });

  driverForm.addEventListener("submit", async event => {
    event.preventDefault();
    clearNotice(driverNotice);
    setFormBusy(driverForm, true);
    const data = new FormData(driverForm);
    const values = {
      display_name: clean(data.get("display_name")),
      email: nullable(data.get("email")),
      phone: nullable(data.get("phone")),
      starting_area: nullable(data.get("starting_area")),
      notes: nullable(data.get("notes")),
      is_active: data.get("is_active") === "on"
    };

    try {
      if (!values.display_name) throw new Error("Driver name is required.");
      if (editingDriverId) await AdministrationService.updateDriver(editingDriverId, values);
      else await AdministrationService.createDriver(values);
      closeDialog(driverModal);
      setNotice(notice, editingDriverId ? "Driver updated." : "Driver added.", "success");
      await loadDrivers();
    } catch (error) {
      setNotice(driverNotice, error.message, "error");
    } finally {
      setFormBusy(driverForm, false);
    }
  });

  document.querySelector("#delete-driver").addEventListener("click", async () => {
    const driver = drivers.find(item => item.id === editingDriverId);
    if (!driver) return;
    const routeText = driver.routes.length ? ` This will also delete ${driver.routes.length} delivery area${driver.routes.length === 1 ? "" : "s"}.` : "";
    if (!await confirmAction({ title: "Delete Driver?", message: `Delete ${driver.display_name}?${routeText}`, confirmLabel: "Delete Driver", urgent: true })) return;
    try {
      await AdministrationService.deleteDriver(driver.id);
      closeDialog(driverModal);
      setNotice(notice, "Driver deleted.", "success");
      await loadDrivers();
    } catch (error) {
      setNotice(driverNotice, error.message, "error");
    }
  });

  list.addEventListener("click", event => {
    const editDriver = event.target.closest("[data-edit-driver]");
    const addRoute = event.target.closest("[data-add-route]");
    const editRoute = event.target.closest("[data-edit-route]");
    const viewRoute = event.target.closest("[data-view-route]");
    const compareRoute = event.target.closest("[data-compare-route]");
    const toggleRoute = event.target.closest("[data-toggle-route]");
    const deleteRoute = event.target.closest("[data-delete-route]");

    if (editDriver) openDriverEditor(editDriver.dataset.editDriver);
    if (addRoute) openRouteEditor(addRoute.dataset.addRoute, null);
    if (editRoute) openRouteEditor(editRoute.dataset.driverId, editRoute.dataset.editRoute);
    if (viewRoute) openRoutePreview(viewRoute.dataset.viewRoute);
    if (compareRoute) compareCustomers(compareRoute.dataset.compareRoute);
    if (toggleRoute) toggleRouteActive(toggleRoute.dataset.toggleRoute);
    if (deleteRoute) removeRoute(deleteRoute.dataset.deleteRoute);
  });

  routeForm.elements.coverage_type.addEventListener("change", updateCoverageFields);

  routeForm.addEventListener("submit", async event => {
    event.preventDefault();
    clearNotice(routeNotice);
    const data = new FormData(routeForm);
    const coverageType = String(data.get("coverage_type") || "path");
    const file = routeForm.elements.route_file.files[0];
    const existing = findRoute(editingRouteId);

    setFormBusy(routeForm, true, coverageType === "path" && file ? "Importing route…" : "Saving delivery area…");
    try {
      const common = {
        driver_id: String(data.get("driver_id")),
        route_name: clean(data.get("route_name")),
        route_type: String(data.get("route_type") || "normal_commute"),
        coverage_type: coverageType,
        description: nullable(data.get("description")),
        allowed_distance_miles: clampDistance(data.get("allowed_distance_miles")),
        is_active: data.get("is_active") === "on"
      };
      if (!common.route_name) throw new Error("Delivery area name is required.");

      if (coverageType === "radius") {
        const centerAddress = clean(data.get("center_address"));
        if (!centerAddress) throw new Error("Enter the center address for this point/radius area.");
        const geocode = await AdministrationService.geocodeAddress(centerAddress);
        await AdministrationService.saveImportedRoute(editingRouteId, {
          ...common,
          center_address: centerAddress,
          center_latitude: geocode.latitude,
          center_longitude: geocode.longitude,
          geometry: null,
          point_count: 1,
          bounds: null,
          source_filename: null,
          source_format: null,
          imported_at: new Date().toISOString()
        });
        setNotice(notice, `${common.route_name} saved as a ${common.allowed_distance_miles}-mile radius around ${centerAddress}.`, "success");
      } else {
        if (!file && (!existing || existing.coverage_type !== "path" || !existing.geometry)) {
          throw new Error("Choose a KML or KMZ route file.");
        }
        const base = {
          ...common,
          center_address: null,
          center_latitude: null,
          center_longitude: null
        };
        if (file) {
          const parsed = await parseRouteFile(file);
          await AdministrationService.saveImportedRoute(editingRouteId, {
            ...base,
            geometry: parsed.geometry,
            point_count: parsed.point_count,
            bounds: parsed.bounds,
            source_filename: parsed.source_filename,
            source_format: parsed.source_format,
            imported_at: new Date().toISOString()
          });
          setNotice(notice, `${common.route_name} imported with ${parsed.point_count.toLocaleString()} route points.`, "success");
        } else {
          await AdministrationService.updateRoute(editingRouteId, base);
          setNotice(notice, `${common.route_name} updated.`, "success");
        }
      }

      closeDialog(routeModal);
      await loadDrivers();
    } catch (error) {
      setNotice(routeNotice, error.message, "error");
    } finally {
      setFormBusy(routeForm, false);
    }
  });

  function openDriverEditor(driverId) {
    const driver = drivers.find(item => item.id === driverId);
    if (!driver) return;
    editingDriverId = driver.id;
    driverForm.reset();
    driverForm.elements.display_name.value = driver.display_name || "";
    driverForm.elements.email.value = driver.email || "";
    driverForm.elements.phone.value = driver.phone || "";
    driverForm.elements.starting_area.value = driver.starting_area || "";
    driverForm.elements.notes.value = driver.notes || "";
    driverForm.elements.is_active.checked = driver.is_active;
    document.querySelector("#driver-dialog-title").textContent = "Edit Delivery Driver";
    document.querySelector("#delete-driver").hidden = false;
    clearNotice(driverNotice);
    openDialog(driverModal);
  }

  function openRouteEditor(driverId, routeId) {
    const driver = drivers.find(item => item.id === driverId);
    if (!driver) return;
    const route = routeId ? driver.routes.find(item => item.id === routeId) : null;
    editingRouteId = route?.id || null;
    routeForm.reset();
    routeForm.elements.driver_id.value = driver.id;
    routeForm.elements.route_name.value = route?.route_name || "";
    routeForm.elements.route_type.value = route?.route_type || "normal_commute";
    routeForm.elements.coverage_type.value = route?.coverage_type || "path";
    routeForm.elements.description.value = route?.description || "";
    routeForm.elements.allowed_distance_miles.value = Number(route?.allowed_distance_miles ?? 5);
    routeForm.elements.center_address.value = route?.center_address || "";
    routeForm.elements.is_active.checked = route?.is_active ?? true;
    document.querySelector("#route-dialog-title").textContent = route ? "Edit Delivery Area" : `Add Delivery Area for ${driver.display_name}`;
    routeFileHelp.textContent = route?.source_filename
      ? `Current file: ${route.source_filename}. Leave blank to keep this geometry, or choose a new KML/KMZ to replace it.`
      : "Export a directions/route layer from Google My Maps as KML or KMZ.";
    clearNotice(routeNotice);
    updateCoverageFields();
    openDialog(routeModal);
  }

  function updateCoverageFields() {
    const coverage = routeForm.elements.coverage_type.value;
    const pathFields = routeForm.querySelectorAll("[data-coverage-path]");
    const radiusFields = routeForm.querySelectorAll("[data-coverage-radius]");
    pathFields.forEach(el => el.hidden = coverage !== "path");
    radiusFields.forEach(el => el.hidden = coverage !== "radius");
    routeForm.elements.route_file.required = coverage === "path" && !findRoute(editingRouteId)?.geometry;
    routeForm.elements.center_address.required = coverage === "radius";
    document.querySelector("#distance-label").textContent = coverage === "radius" ? "Circle radius" : "Delivery distance from route";
    document.querySelector("#route-submit").textContent = coverage === "radius" ? "Save Point / Radius" : (editingRouteId ? "Save Route" : "Import Route");
  }

  function openRoutePreview(routeId) {
    const route = findRoute(routeId);
    if (!route) return;
    document.querySelector("#route-preview-title").textContent = route.route_name;
    document.querySelector("#route-preview-meta").textContent = route.coverage_type === "radius"
      ? `${route.allowed_distance_miles} mile radius · ${route.center_address || "center point"}`
      : `${Number(route.point_count || 0).toLocaleString()} route points · ${route.allowed_distance_miles} mile matching distance`;
    document.querySelector("#route-preview-canvas").innerHTML = routePreviewSvg(route);
    openDialog(previewModal);
  }

  async function compareCustomers(routeId) {
    const route = findRoute(routeId);
    if (!route) return;
    const title = document.querySelector("#customer-match-title");
    const summary = document.querySelector("#customer-match-summary");
    const body = document.querySelector("#customer-match-body");
    title.textContent = `Customer Match — ${route.route_name}`;
    summary.textContent = "Loading customer addresses…";
    body.innerHTML = `<div class="driver-match-loading">Comparing addresses…</div>`;
    openDialog(matchModal);

    try {
      const customers = await AdministrationService.listDeliveryCustomers();
      const addressed = customers.filter(customer => customerAddress(customer));
      const results = [];
      let geocodedNow = 0;
      let failed = 0;

      for (const customer of addressed) {
        const address = customerAddress(customer);
        let lat = Number(customer.geocode_latitude);
        let lng = Number(customer.geocode_longitude);
        const cacheCurrent = Number.isFinite(lat) && Number.isFinite(lng) && customer.geocode_address === address;

        if (!cacheCurrent) {
          try {
            const geo = await AdministrationService.geocodeAddress(address);
            lat = Number(geo.latitude);
            lng = Number(geo.longitude);
            geocodedNow += 1;
            await AdministrationService.saveCustomerGeocode(customer.id, {
              geocode_latitude: lat,
              geocode_longitude: lng,
              geocode_address: address,
              geocode_source: geo.source || "US Census Geocoder",
              geocoded_at: new Date().toISOString()
            });
          } catch (error) {
            failed += 1;
            results.push({ customer, address, error: error.message });
            continue;
          }
        }

        const miles = distanceToCoverage(route, lat, lng);
        results.push({ customer, address, miles, eligible: miles <= Number(route.allowed_distance_miles || 0) });
      }

      results.sort((a, b) => {
        if (a.error && !b.error) return 1;
        if (!a.error && b.error) return -1;
        return (a.miles ?? Infinity) - (b.miles ?? Infinity);
      });
      const eligible = results.filter(item => item.eligible).length;
      summary.textContent = `${eligible} of ${addressed.length} addressed customers are within ${route.allowed_distance_miles} miles. ${geocodedNow ? `${geocodedNow} address${geocodedNow === 1 ? "" : "es"} geocoded now. ` : ""}${failed ? `${failed} could not be matched.` : ""}`.trim();
      body.innerHTML = renderCustomerMatches(results, route);
    } catch (error) {
      summary.textContent = "Customer comparison could not be completed.";
      body.innerHTML = `<div class="notice notice--error">${escapeHtml(error.message)}</div>`;
    }
  }

  async function toggleRouteActive(routeId) {
    const route = findRoute(routeId);
    if (!route) return;
    try {
      await AdministrationService.updateRoute(route.id, { is_active: !route.is_active });
      await loadDrivers();
    } catch (error) {
      setNotice(notice, error.message, "error");
    }
  }

  async function removeRoute(routeId) {
    const route = findRoute(routeId);
    if (!route) return;
    if (!await confirmAction({ title: "Delete Delivery Area?", message: `Delete delivery area “${route.route_name}”?`, confirmLabel: "Delete Area", urgent: true })) return;
    try {
      await AdministrationService.deleteRoute(route.id);
      setNotice(notice, "Delivery area deleted.", "success");
      await loadDrivers();
    } catch (error) {
      setNotice(notice, error.message, "error");
    }
  }

  function findRoute(routeId) {
    if (!routeId) return null;
    return drivers.flatMap(driver => driver.routes).find(route => route.id === routeId) || null;
  }

  async function loadDrivers() {
    try {
      drivers = await AdministrationService.listDrivers();
      renderDrivers(list, drivers);
    } catch (error) {
      setNotice(notice, error.message, "error");
    }
  }

  await loadDrivers();
  return { reload: loadDrivers };
}

function renderDrivers(container, drivers) {
  if (!drivers.length) {
    container.innerHTML = `<div class="empty-state driver-empty-state">No delivery drivers have been added yet.</div>`;
    return;
  }

  container.innerHTML = drivers.map(driver => `
    <article class="driver-card ${driver.is_active ? "" : "driver-card--inactive"}">
      <div class="driver-card__header">
        <div>
          <div class="driver-card__title-row">
            <h3>${escapeHtml(driver.display_name)}</h3>
            <span class="status-badge ${driver.is_active ? "status-badge--active" : "status-badge--inactive"}">${driver.is_active ? "Active" : "Inactive"}</span>
          </div>
          <p>${escapeHtml(driver.starting_area || "No starting area entered")}</p>
          ${driver.email || driver.phone ? `<p class="cell-note">${escapeHtml([driver.email, driver.phone].filter(Boolean).join(" · "))}</p>` : ""}
        </div>
        <div class="driver-card__actions">
          <button class="portal-button portal-button--secondary" type="button" data-edit-driver="${driver.id}">Edit Driver</button>
          <button class="portal-button" type="button" data-add-route="${driver.id}">Add Delivery Area</button>
        </div>
      </div>
      ${driver.notes ? `<p class="driver-card__notes">${escapeHtml(driver.notes)}</p>` : ""}
      <div class="driver-routes">
        <div class="driver-routes__heading">
          <strong>Delivery Areas</strong>
          <span>${driver.routes.length} configured</span>
        </div>
        ${driver.routes.length ? driver.routes.map(route => routeRow(driver.id, route)).join("") : `<div class="driver-route-empty">No routes or point/radius areas configured for this driver.</div>`}
      </div>
    </article>`).join("");
}

function routeRow(driverId, route) {
  const miles = Number(route.allowed_distance_miles || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const coverage = route.coverage_type || "path";
  const details = coverage === "radius"
    ? `<span>${miles} mi circle</span><span>${escapeHtml(route.center_address || "No center address")}</span>`
    : `<span>${miles} mi from route</span><span>${Number(route.point_count || 0).toLocaleString()} points</span>${route.source_filename ? `<span>${escapeHtml(route.source_filename)}</span>` : ""}`;
  return `<div class="driver-route-row ${route.is_active ? "" : "driver-route-row--inactive"}">
    <div class="driver-route-row__main">
      <div class="driver-route-row__name">
        <strong>${escapeHtml(route.route_name)}</strong>
        <span class="status-badge status-badge--info">${escapeHtml(COVERAGE_LABELS[coverage] || coverage)}</span>
        <span class="status-badge ${route.is_active ? "status-badge--active" : "status-badge--inactive"}">${route.is_active ? "Active" : "Inactive"}</span>
      </div>
      <div class="driver-route-row__meta">
        <span>${escapeHtml(ROUTE_TYPE_LABELS[route.route_type] || route.route_type)}</span>
        ${details}
      </div>
      ${route.description ? `<p>${escapeHtml(route.description)}</p>` : ""}
    </div>
    <div class="driver-route-row__actions">
      <button class="table-action" type="button" data-view-route="${route.id}">View</button>
      <button class="table-action" type="button" data-compare-route="${route.id}">Compare Customers</button>
      <button class="table-action" type="button" data-edit-route="${route.id}" data-driver-id="${driverId}">Edit</button>
      <button class="table-action" type="button" data-toggle-route="${route.id}">${route.is_active ? "Deactivate" : "Activate"}</button>
      <button class="table-action table-action--danger" type="button" data-delete-route="${route.id}">Delete</button>
    </div>
  </div>`;
}

function driverDialog() {
  return `<dialog class="portal-dialog" id="driver-dialog">
    <form class="dialog-card" id="driver-form">
      <div class="dialog-header"><h2 id="driver-dialog-title">Add Delivery Driver</h2><button class="icon-button" data-close type="button" aria-label="Close">×</button></div>
      <div class="form-grid">
        <label class="form-field form-field--full"><span>Driver name</span><input name="display_name" required></label>
        <label class="form-field"><span>Email</span><input name="email" type="email"></label>
        <label class="form-field"><span>Phone</span><input name="phone" type="tel"></label>
        <label class="form-field form-field--full"><span>Home / starting area</span><input name="starting_area" placeholder="Example: Raymore, Missouri"></label>
        <label class="form-field form-field--full"><span>Notes</span><textarea name="notes" rows="3"></textarea></label>
        <label class="checkbox-field form-field--full"><input name="is_active" type="checkbox" checked> Active driver</label>
      </div>
      <div id="driver-form-notice" class="notice" hidden></div>
      <div class="dialog-actions dialog-actions--split">
        <button class="portal-button portal-button--danger" id="delete-driver" type="button" hidden>Delete Driver</button>
        <div><button class="portal-button portal-button--secondary" data-close type="button">Cancel</button><button class="portal-button" type="submit">Save Driver</button></div>
      </div>
    </form>
  </dialog>`;
}

function routeDialog() {
  return `<dialog class="portal-dialog" id="route-dialog">
    <form class="dialog-card dialog-card--route" id="route-form">
      <div class="dialog-header"><h2 id="route-dialog-title">Add Delivery Area</h2><button class="icon-button" data-close type="button" aria-label="Close">×</button></div>
      <input name="driver_id" type="hidden">
      <div class="form-grid">
        <label class="form-field form-field--full"><span>Delivery area name</span><input name="route_name" placeholder="Example: Work to Home via US-71 or Church 10-mile Area" required></label>
        <label class="form-field"><span>Coverage</span><select name="coverage_type"><option value="path">Route Path — KML/KMZ</option><option value="radius">Point / Radius — Address</option></select></label>
        <label class="form-field"><span>Route purpose</span><select name="route_type"><option value="normal_commute">Normal commute</option><option value="pack_meeting">Pack meeting</option><option value="other">Other</option></select></label>
        <label class="form-field form-field--full" data-coverage-radius hidden><span>Center address</span><input name="center_address" placeholder="Example: 123 Main St, Lee's Summit, MO 64063"><small>The address is converted to coordinates when saved.</small></label>
        <label class="form-field form-field--full route-file-field" data-coverage-path><span>Google My Maps route file</span><input name="route_file" type="file" accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz"><small id="route-file-help">Export a directions/route layer from Google My Maps as KML or KMZ.</small></label>
        <label class="form-field"><span id="distance-label">Delivery distance from route</span><div class="input-suffix"><input name="allowed_distance_miles" type="number" min="0" max="100" step="0.25" value="5" required><span>miles</span></div></label>
        <label class="form-field form-field--full"><span>Description</span><textarea name="description" rows="2" placeholder="Optional notes about when or why this area is used"></textarea></label>
        <label class="checkbox-field form-field--full"><input name="is_active" type="checkbox" checked> Use this area for delivery matching</label>
      </div>
      <div class="route-import-note"><strong>Route Path:</strong> customers are measured from the nearest point on the imported route. <strong>Point / Radius:</strong> customers are measured from the center address.</div>
      <div id="route-form-notice" class="notice" hidden></div>
      <div class="dialog-actions"><button class="portal-button portal-button--secondary" data-close type="button">Cancel</button><button class="portal-button" id="route-submit" type="submit">Import Route</button></div>
    </form>
  </dialog>`;
}

function routePreviewDialog() {
  return `<dialog class="portal-dialog" id="route-preview-dialog">
    <div class="dialog-card dialog-card--route-preview">
      <div class="dialog-header"><div><h2 id="route-preview-title">Delivery Area</h2><p id="route-preview-meta" class="cell-note"></p></div><button class="icon-button" data-close type="button" aria-label="Close">×</button></div>
      <div id="route-preview-canvas" class="route-preview-canvas"></div>
      <p class="cell-note route-preview-note">Preview shows the stored route/coverage shape. It is not a street map and is not intended for navigation.</p>
      <div class="dialog-actions"><button class="portal-button portal-button--secondary" data-close type="button">Close</button></div>
    </div>
  </dialog>`;
}

function customerMatchDialog() {
  return `<dialog class="portal-dialog" id="customer-match-dialog">
    <div class="dialog-card dialog-card--matches">
      <div class="dialog-header"><div><h2 id="customer-match-title">Customer Match</h2><p id="customer-match-summary" class="cell-note"></p></div><button class="icon-button" data-close type="button" aria-label="Close">×</button></div>
      <div id="customer-match-body" class="customer-match-body"></div>
      <div class="dialog-actions"><button class="portal-button portal-button--secondary" data-close type="button">Close</button></div>
    </div>
  </dialog>`;
}

function routePreviewSvg(route) {
  if ((route.coverage_type || "path") === "radius") {
    return `<svg viewBox="0 0 640 360" role="img" aria-label="Circular delivery area preview"><rect width="640" height="360" class="route-preview-bg"/><circle cx="320" cy="180" r="128" class="route-preview-radius"/><circle cx="320" cy="180" r="7" class="route-preview-center"/><text x="320" y="180" dy="-18" text-anchor="middle" class="route-preview-label">${escapeHtml(String(route.allowed_distance_miles))} mile radius</text><text x="320" y="180" dy="28" text-anchor="middle" class="route-preview-subtext">${escapeHtml(route.center_address || "Center point")}</text></svg>`;
  }

  const lines = route.geometry?.coordinates || [];
  const points = lines.flat().filter(point => Array.isArray(point) && point.length >= 2);
  if (!points.length) return `<div class="driver-route-empty">No stored route geometry is available to preview.</div>`;
  let minX = Math.min(...points.map(p => Number(p[0]))), maxX = Math.max(...points.map(p => Number(p[0])));
  let minY = Math.min(...points.map(p => Number(p[1]))), maxY = Math.max(...points.map(p => Number(p[1])));
  if (maxX === minX) maxX += .001;
  if (maxY === minY) maxY += .001;
  const pad = 28, width = 640, height = 360;
  const sx = (width - pad * 2) / (maxX - minX), sy = (height - pad * 2) / (maxY - minY);
  const scale = Math.min(sx, sy);
  const usedW = (maxX - minX) * scale, usedH = (maxY - minY) * scale;
  const ox = (width - usedW) / 2, oy = (height - usedH) / 2;
  const pathData = lines.map(line => line.map((p, i) => {
    const x = ox + (Number(p[0]) - minX) * scale;
    const y = height - (oy + (Number(p[1]) - minY) * scale);
    return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ")).join(" ");
  return `<svg viewBox="0 0 640 360" role="img" aria-label="Imported KML route preview"><rect width="640" height="360" class="route-preview-bg"/><path d="${pathData}" class="route-preview-path"/></svg>`;
}

function renderCustomerMatches(results, route) {
  if (!results.length) return `<div class="driver-route-empty">No customers with street addresses were found.</div>`;
  return `<div class="customer-match-table"><div class="customer-match-row customer-match-row--header"><span>Customer</span><span>Address</span><span>Distance</span><span>Status</span></div>${results.map(item => {
    const name = customerName(item.customer);
    if (item.error) return `<div class="customer-match-row"><span><strong>${escapeHtml(name)}</strong></span><span>${escapeHtml(item.address)}</span><span>—</span><span class="match-error">No match</span></div>`;
    const distance = `${item.miles.toFixed(item.miles < 10 ? 2 : 1)} mi`;
    return `<div class="customer-match-row ${item.eligible ? "customer-match-row--eligible" : ""}"><span><strong>${escapeHtml(name)}</strong></span><span>${escapeHtml(item.address)}</span><span>${distance}</span><span><span class="status-badge ${item.eligible ? "status-badge--active" : "status-badge--inactive"}">${item.eligible ? "Delivery" : "Outside"}</span></span></div>`;
  }).join("")}</div><p class="cell-note customer-match-footnote">Distance is ${route.coverage_type === "radius" ? "straight-line distance from the center point" : "the shortest calculated distance to the imported route line"}. It does not represent driving mileage.</p>`;
}

function customerAddress(customer) {
  return [customer.address_line_1, customer.address_line_2, [customer.city, customer.state, customer.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ").trim();
}

function customerName(customer) {
  return [customer.first_name, customer.last_name].filter(Boolean).join(" ") || customer.company_name || "Unnamed customer";
}

function distanceToCoverage(route, lat, lng) {
  if ((route.coverage_type || "path") === "radius") {
    return haversineMiles(lat, lng, Number(route.center_latitude), Number(route.center_longitude));
  }
  const lines = route.geometry?.coordinates || [];
  let best = Infinity;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      best = Math.min(best, pointToSegmentMiles(lat, lng, Number(a[1]), Number(a[0]), Number(b[1]), Number(b[0])));
    }
    if (line.length === 1) best = Math.min(best, haversineMiles(lat, lng, Number(line[0][1]), Number(line[0][0])));
  }
  return best;
}

function pointToSegmentMiles(lat, lng, lat1, lng1, lat2, lng2) {
  const meanLat = ((lat + lat1 + lat2) / 3) * Math.PI / 180;
  const milesPerDegLat = 69.0;
  const milesPerDegLng = 69.172 * Math.cos(meanLat);
  const px = lng * milesPerDegLng, py = lat * milesPerDegLat;
  const ax = lng1 * milesPerDegLng, ay = lat1 * milesPerDegLat;
  const bx = lng2 * milesPerDegLng, by = lat2 * milesPerDegLat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const r = 3958.7613;
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function clean(value) { return String(value || "").trim(); }
function nullable(value) { const result = clean(value); return result || null; }
function clampDistance(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Enter a valid delivery distance.");
  return Math.min(100, Math.max(0, number));
}
