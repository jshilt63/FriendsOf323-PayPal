import { escapeHtml } from "../components/layout.js?v=1.9.0";

export function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(Number(value || 0));
}

export function text(value, fallback = "—") {
  const clean = String(value ?? "").trim();
  return clean || fallback;
}

export function setNotice(element, message, type = "info") {
  element.textContent = message;
  element.className = type === "error" ? "notice notice--error"
    : type === "success" ? "notice notice--success"
    : "notice";
  element.hidden = false;
}

export function clearNotice(element) {
  element.hidden = true;
  element.textContent = "";
}

export function openDialog(dialog) {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

export function closeDialog(dialog) {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

export function setFormBusy(form, busy, label = "Saving…") {
  const button = form.querySelector('button[type="submit"]');
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || "Save";
    button.disabled = false;
  }
}

export function renderEmptyRow(colspan, message) {
  return `<tr><td colspan="${colspan}" class="empty-state">${escapeHtml(message)}</td></tr>`;
}

export function normalizeNullable(value) {
  const clean = String(value ?? "").trim();
  return clean || null;
}

export function searchMatches(values, query) {
  if (!query) return true;
  const haystack = values.map(value => String(value ?? "")).join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}