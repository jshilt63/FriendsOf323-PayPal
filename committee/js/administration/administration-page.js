import { requirePortalUser } from "../../assets/auth-common.js";
import { renderPortalLayout, escapeHtml } from "../components/layout.js?v=1.9.32";
import { DataGrid } from "../components/data-grid.js";
import { ROLE_LABELS } from "../shared/roles.js";
import { AdministrationService } from "../services/administration-service.js?v=1.9.6";
import { driversPanelMarkup, driverDialogsMarkup, initializeDriversAdmin } from "./drivers-admin.js";
import { shippingPanelMarkup, shippingDialogMarkup, initializeShippingAdmin } from "./shipping-admin.js?v=1.9.8";
import { storeNoticePanelMarkup, initializeStoreNoticeAdmin } from "./store-notice-admin.js?v=1.9.6";
import { roasterPanelMarkup, initializeRoasterAdmin } from "./roaster-admin.js?v=1.9.32";
import { fundsPanelMarkup, initializeFundsAdmin } from "./funds-admin.js?v=1.9.32";
import {
  clearNotice, closeDialog, openDialog, setFormBusy, setNotice
} from "../master-data/shared.js";

const result = await requirePortalUser({ allowedRoles: ["coffee_bean"] });
if (result) initialize(result);

async function initialize({ user, profile }) {
  const content = renderPortalLayout({ profile, user, pageTitle: "Administration" });

  content.innerHTML = `
    <div class="breadcrumb">Committee Portal / Administration</div>
    <div class="page-heading">
      <div>
        <h1>Administration</h1>
        <p>Manage portal users, delivery drivers, shipping, storefront notices, products, reports, and audit history.</p>
      </div>
      <button class="portal-button" id="invite-user" type="button">Invite User</button>
    </div>

    <div id="page-notice" class="notice" hidden></div>

    <section id="users-panel" class="admin-panel">
      <div id="users-grid"></div>
    </section>

    ${driversPanelMarkup()}
    ${shippingPanelMarkup()}
    ${storeNoticePanelMarkup()}
    ${roasterPanelMarkup()}
    ${fundsPanelMarkup()}

    <section id="audit-panel" class="admin-panel" hidden>
      <div class="audit-toolbar">
        <p class="cell-note">Most recent 250 recorded changes.</p>
        <button class="portal-button portal-button--secondary" id="refresh-audit" type="button">Refresh</button>
      </div>
      <div id="audit-grid"></div>
    </section>

    ${inviteDialog()}
    ${editDialog()}
    ${driverDialogsMarkup()}
    ${shippingDialogMarkup()}
  `;

  const notice = document.querySelector("#page-notice");
  let users = [];
  let dens = [];
  let auditRows = [];

  const usersGrid = new DataGrid({
    container: document.querySelector("#users-grid"),
    columns: [
      {
        key: "display_name",
        label: "User",
        render: row => `<strong>${escapeHtml(row.display_name || row.email || "Unnamed user")}</strong>
          <div class="cell-note">${escapeHtml(row.email || "No email available")}</div>`
      },
      {
        key: "role",
        label: "Access Level",
        render: row => `<span class="status-badge status-badge--info">${escapeHtml(ROLE_LABELS[row.role] || row.role)}</span>`
      },
      {
        key: "den_display",
        label: "Assigned Den",
        render: row => escapeHtml(row.den_display || "—")
      },
      {
        key: "is_active",
        label: "Status",
        render: row => `<span class="status-badge ${row.is_active ? "status-badge--active" : "status-badge--inactive"}">${row.is_active ? "Active" : "Inactive"}</span>`
      },
      {
        key: "last_sign_in_at",
        label: "Last Sign In",
        render: row => formatDateTime(row.last_sign_in_at)
      },
      {
        key: "created_at",
        label: "Created",
        render: row => formatDateTime(row.created_at)
      },
      {
        key: "actions",
        label: "Actions",
        sortable: false,
        exportable: false,
        render: row => `<button class="table-action" type="button" data-edit-user="${row.id}">Edit</button>`
      }
    ],
    searchFields: ["display_name", "email", "role"],
    pageSize: 15,
    emptyMessage: "No portal users were found.",
    exportFileName: "friends-of-323-users.csv"
  });

  const auditGrid = new DataGrid({
    container: document.querySelector("#audit-grid"),
    columns: [
      {
        key: "changed_at",
        label: "Date/Time",
        render: row => formatDateTime(row.changed_at)
      },
      { key: "table_name", label: "Table" },
      { key: "action", label: "Action" },
      {
        key: "changed_by_name",
        label: "Changed By",
        render: row => escapeHtml(row.changed_by_name || row.changed_by || "System")
      },
      {
        key: "record_id",
        label: "Record",
        render: row => `<span class="audit-record">${escapeHtml(row.record_id || "—")}</span>`
      },
      {
        key: "details",
        label: "Change",
        sortable: false,
        render: row => `<details class="audit-details"><summary>View changes</summary>${renderChangeDetails(row)}</details>`
      }
    ],
    searchFields: ["table_name", "action", "changed_by_name", "record_id"],
    pageSize: 20,
    emptyMessage: "No audit records were found.",
    exportFileName: "friends-of-323-audit-log.csv"
  });

  const activeAdminTab = new URLSearchParams(window.location.search).get("tab") || "users";
  const validAdminTabs = ["users", "drivers", "shipping", "store-notice", "roaster", "funds", "audit"];
  const tab = validAdminTabs.includes(activeAdminTab) ? activeAdminTab : "users";
  document.querySelector("#users-panel").hidden = tab !== "users";
  document.querySelector("#drivers-panel").hidden = tab !== "drivers";
  document.querySelector("#shipping-panel").hidden = tab !== "shipping";
  document.querySelector("#store-notice-panel").hidden = tab !== "store-notice";
  document.querySelector("#roaster-panel").hidden = tab !== "roaster";
  document.querySelector("#funds-panel").hidden = tab !== "funds";
  document.querySelector("#audit-panel").hidden = tab !== "audit";
  document.querySelector("#invite-user").hidden = tab !== "users";

  document.querySelector("#refresh-audit").addEventListener("click", loadAudit);
  if (tab === "audit" && auditRows.length === 0) await loadAudit();

  const inviteModal = document.querySelector("#invite-dialog");
  const inviteForm = document.querySelector("#invite-form");
  const inviteNotice = document.querySelector("#invite-form-notice");

  document.querySelector("#invite-user").addEventListener("click", () => {
    inviteForm.reset();
    inviteForm.elements.role.value = "committee_member";
    clearNotice(inviteNotice);
    openDialog(inviteModal);
  });
  inviteModal.querySelectorAll("[data-close]").forEach(button =>
    button.addEventListener("click", () => closeDialog(inviteModal)));

  inviteForm.addEventListener("submit", async event => {
    event.preventDefault();
    clearNotice(inviteNotice);
    setFormBusy(inviteForm, true, "Sending invitation…");

    const data = new FormData(inviteForm);
    try {
      await AdministrationService.inviteUser({
        email: String(data.get("email") || "").trim(),
        displayName: String(data.get("display_name") || "").trim(),
        role: String(data.get("role") || "committee_member"),
        denId: String(data.get("den_id") || "") || null
      });
      closeDialog(inviteModal);
      setNotice(notice, "Invitation sent. The user will set a password from the email link.", "success");
      await loadUsers();
    } catch (error) {
      setNotice(inviteNotice, error.message, "error");
    } finally {
      setFormBusy(inviteForm, false);
    }
  });

  const editModal = document.querySelector("#edit-user-dialog");
  const editForm = document.querySelector("#edit-user-form");
  const editNotice = document.querySelector("#edit-user-form-notice");
  const resendInviteButton = document.querySelector("#resend-invite");
  const passwordResetButton = document.querySelector("#send-password-reset");
  let editingUser = null;

  editModal.querySelectorAll("[data-close]").forEach(button =>
    button.addEventListener("click", () => closeDialog(editModal)));

  resendInviteButton.addEventListener("click", async () => {
    if (!editingUser) return;
    clearNotice(editNotice);
    setActionBusy(resendInviteButton, true, "Sending invitation…");
    passwordResetButton.disabled = true;
    try {
      await AdministrationService.resendInvite(editingUser.id);
      setNotice(editNotice, `A new invitation was sent to ${editingUser.email}.`, "success");
      await loadUsers();
      editingUser = users.find(item => item.id === editingUser?.id) || editingUser;
      updateEmailActions(editingUser);
    } catch (error) {
      setNotice(editNotice, error.message, "error");
    } finally {
      setActionBusy(resendInviteButton, false);
      updateEmailActions(editingUser);
    }
  });

  passwordResetButton.addEventListener("click", async () => {
    if (!editingUser) return;
    clearNotice(editNotice);
    setActionBusy(passwordResetButton, true, "Sending reset…");
    resendInviteButton.disabled = true;
    try {
      await AdministrationService.sendPasswordReset(editingUser.id);
      setNotice(editNotice, `A password reset email was sent to ${editingUser.email}.`, "success");
    } catch (error) {
      setNotice(editNotice, error.message, "error");
    } finally {
      setActionBusy(passwordResetButton, false);
      updateEmailActions(editingUser);
    }
  });

  editForm.addEventListener("submit", async event => {
    event.preventDefault();
    clearNotice(editNotice);
    setFormBusy(editForm, true);

    const data = new FormData(editForm);
    const id = String(data.get("id") || "");
    const target = users.find(item => item.id === id);

    const isSelf = id === user.id;
    const requestedActive = data.get("is_active") === "on";
    const receiveOrderNotifications = data.get("receive_order_notifications") === "on";

    if (isSelf && !requestedActive) {
      setNotice(editNotice, "You cannot deactivate your own account.", "error");
      setFormBusy(editForm, false);
      return;
    }

    try {
      await AdministrationService.updateUserProfile(id, {
        display_name: String(data.get("display_name") || "").trim() || null,
        role: String(data.get("role")),
        den_id: String(data.get("role")) === "barista" ? (String(data.get("den_id") || "") || null) : null,
        is_active: isSelf ? true : requestedActive,
        receive_order_notifications: receiveOrderNotifications
      });
      closeDialog(editModal);
      setNotice(notice, `${target?.email || "User"} updated.`, "success");
      await loadUsers();
    } catch (error) {
      setNotice(editNotice, error.message, "error");
    } finally {
      setFormBusy(editForm, false);
    }
  });

  document.querySelector("#users-grid").addEventListener("click", event => {
    const button = event.target.closest("[data-edit-user]");
    if (!button) return;
    const target = users.find(item => item.id === button.dataset.editUser);
    if (!target) return;
    editingUser = target;

    editForm.elements.id.value = target.id;
    editForm.elements.email.value = target.email || "";
    editForm.elements.display_name.value = target.display_name || "";
    editForm.elements.role.value = target.role;
    editForm.elements.den_id.value = target.den_id || "";
    toggleDenField(editForm);
    editForm.elements.is_active.checked = target.is_active;
    editForm.elements.is_active.disabled = false;
    editForm.elements.receive_order_notifications.checked =
      target.receive_order_notifications === true;
    document.querySelector("#self-account-note").hidden = target.id !== user.id;
    clearNotice(editNotice);
    updateEmailActions(target);
    openDialog(editModal);
  });

  function updateEmailActions(target) {
    if (!target) return;
    const invitationPending = !target.email_confirmed_at;
    resendInviteButton.hidden = !invitationPending;
    resendInviteButton.disabled = !invitationPending;
    passwordResetButton.hidden = invitationPending;
    passwordResetButton.disabled = invitationPending;
    document.querySelector("#account-email-status").textContent = invitationPending
      ? "Invitation pending. You can send a fresh invitation if the original link expired or was lost."
      : "Account activated. You can send this user a password reset email."
  }

  async function loadUsers() {
    try {
      const [response, denRows] = await Promise.all([AdministrationService.listUsers(), AdministrationService.listDens()]);
      dens = denRows || [];
      populateDenSelects();
      const denMap = new Map(dens.map(den => [den.id, den]));
      users = (response.users || []).map(row => ({ ...row, den_display: row.role === "barista" ? denDisplay(denMap.get(row.den_id)) : "—" }));
      usersGrid.setRows(users);
    } catch (error) {
      setNotice(notice, error.message, "error");
    }
  }

  async function loadAudit() {
    try {
      // The Audit tab can be opened directly, before the Users tab has loaded.
      // Load the portal-user list here as needed so changed_by UUIDs can always
      // be resolved to a friendly name.
      const [rows, userResponse] = await Promise.all([
        AdministrationService.getAuditLog(),
        users.length ? Promise.resolve(null) : AdministrationService.listUsers()
      ]);

      if (userResponse?.users) {
        users = userResponse.users;
      }

      const names = new Map(users.map(item => [item.id, item.display_name || item.email]));
      auditRows = rows.map(row => ({
        ...row,
        changed_by_name: names.get(row.changed_by) || null
      }));
      auditGrid.setRows(auditRows);
    } catch (error) {
      setNotice(notice, error.message, "error");
    }
  }

  [inviteForm, editForm].forEach(form => form.elements.role.addEventListener("change", () => toggleDenField(form)));

  function populateDenSelects() {
    [inviteForm.elements.den_id, editForm.elements.den_id].forEach(select => {
      const current = select.value;
      select.innerHTML = '<option value="">No den assigned</option>' + dens.map(den => `<option value="${den.id}">${escapeHtml(denDisplay(den))}</option>`).join('');
      select.value = current;
    });
  }

  await loadUsers();
  await initializeDriversAdmin({ notice });
  const shippingAdmin = initializeShippingAdmin({ notice });
  const storeNoticeAdmin = initializeStoreNoticeAdmin({ notice });
  await shippingAdmin.load();
  if (tab === "store-notice") await storeNoticeAdmin.load();
  if (tab === "roaster") await initializeRoasterAdmin();
  if (tab === "funds") await initializeFundsAdmin();
  toggleDenField(inviteForm);
}

function denDisplay(den) { return den?.den_number ? `Den ${den.den_number} · ${den.current_rank_working_toward}` : "No den assigned"; }
function toggleDenField(form) {
  const field = form.querySelector('[data-den-field]');
  if (!field) return;
  const isBarista = form.elements.role.value === "barista";
  field.hidden = !isBarista;
  form.elements.den_id.disabled = !isBarista;
  if (!isBarista) form.elements.den_id.value = "";
}

function inviteDialog() {
  return `<dialog class="portal-dialog" id="invite-dialog">
    <form class="dialog-card" id="invite-form">
      <div class="dialog-header">
        <h2>Invite Portal User</h2>
        <button class="icon-button" data-close type="button" aria-label="Close">×</button>
      </div>
      <div class="form-grid">
        <label class="form-field form-field--full">
          <span>Email address</span>
          <input name="email" type="email" autocomplete="email" required>
        </label>
        <label class="form-field form-field--full">
          <span>Display name</span>
          <input name="display_name" autocomplete="name">
        </label>
        <label class="form-field form-field--full">
          <span>Access level</span>
          <select name="role" required>
            <option value="committee_member">Cupper — read only</option>
            <option value="barista">Barista — add and update orders</option>
            <option value="treasurer">Bean Counter — confirm payments and deposits</option>
            <option value="coffee_bean">Coffee Bean — full administration</option>
          </select>
        </label>
        <label class="form-field form-field--full" data-den-field hidden>
          <span>Barista den</span>
          <select name="den_id"><option value="">No den assigned</option></select>
        </label>
      </div>
      <div id="invite-form-notice" class="notice" hidden></div>
      <div class="dialog-actions">
        <button class="portal-button portal-button--secondary" data-close type="button">Cancel</button>
        <button class="portal-button" type="submit">Send Invitation</button>
      </div>
    </form>
  </dialog>`;
}

function editDialog() {
  return `<dialog class="portal-dialog" id="edit-user-dialog">
    <form class="dialog-card" id="edit-user-form">
      <div class="dialog-header">
        <h2>Edit Portal User</h2>
        <button class="icon-button" data-close type="button" aria-label="Close">×</button>
      </div>
      <input name="id" type="hidden">
      <div class="form-grid">
        <label class="form-field form-field--full">
          <span>Email address</span>
          <input name="email" type="email" readonly>
        </label>
        <label class="form-field form-field--full">
          <span>Display name</span>
          <input name="display_name">
        </label>
        <label class="form-field form-field--full">
          <span>Access level</span>
          <select name="role" required>
            <option value="committee_member">Cupper</option>
            <option value="barista">Barista</option>
            <option value="treasurer">Bean Counter</option>
            <option value="coffee_bean">Coffee Bean</option>
          </select>
        </label>
        <label class="form-field form-field--full" data-den-field hidden>
          <span>Barista den</span>
          <select name="den_id"><option value="">No den assigned</option></select>
        </label>
        <div class="form-field form-field--full admin-checkbox-row">
          <label class="checkbox-field">
            <input name="is_active" type="checkbox"> Active account
          </label>
          <label class="checkbox-field receive-order-notifications-label">
            <input name="receive_order_notifications" type="checkbox">
            <span>Receive order <br>notifications</span>
          </label>
        </div>
        <p id="self-account-note" class="cell-note form-field--full" hidden>
          Your own account cannot be deactivated from this screen.
        </p>
      </div>
      <div class="account-email-actions" aria-labelledby="account-email-actions-title">
        <strong id="account-email-actions-title">Account email actions</strong>
        <p id="account-email-status" class="cell-note"></p>
        <div class="account-email-actions__buttons">
          <button class="portal-button portal-button--secondary" id="resend-invite" type="button">Resend Invitation</button>
          <button class="portal-button portal-button--secondary" id="send-password-reset" type="button">Send Password Reset</button>
        </div>
      </div>
      <div id="edit-user-form-notice" class="notice" hidden></div>
      <div class="dialog-actions">
        <button class="portal-button portal-button--secondary" data-close type="button">Cancel</button>
        <button class="portal-button" type="submit">Save User</button>
      </div>
    </form>
  </dialog>`;
}

function setActionBusy(button, busy, busyText = "Working…") {
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    delete button.dataset.originalText;
    button.disabled = false;
  }
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function renderChangeDetails(row) {
  const oldData = row.old_data || {};
  const newData = row.new_data || {};
  const keys = [...new Set([...Object.keys(oldData), ...Object.keys(newData)])]
    .filter(key => !["updated_at", "created_at"].includes(key));

  const changes = keys.filter(key =>
    JSON.stringify(oldData[key]) !== JSON.stringify(newData[key]));

  if (!changes.length) return "<p>No field-level differences recorded.</p>";

  return `<div class="audit-change-list">${changes.map(key => `
    <div class="audit-change">
      <strong>${escapeHtml(key.replaceAll("_", " "))}</strong>
      <span>${escapeHtml(formatAuditValue(oldData[key]))}</span>
      <span aria-hidden="true">→</span>
      <span>${escapeHtml(formatAuditValue(newData[key]))}</span>
    </div>`).join("")}</div>`;
}

function formatAuditValue(value) {
  if (value === undefined) return "Not set";
  if (value === null) return "None";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
