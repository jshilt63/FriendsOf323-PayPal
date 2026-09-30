import { escapeHtml } from "./layout.js";

export function operationCard({ tone = "neutral", eyebrow, title, value, detail, secondary = "", href, actionLabel }) {
  return `
    <a class="ops-card ops-card--${escapeHtml(tone)}" href="${escapeHtml(href)}">
      <span class="ops-card__eyebrow">${escapeHtml(eyebrow)}</span>
      <div class="ops-card__value">${escapeHtml(value)}</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(detail)}</p>
      ${secondary ? `<div class="ops-card__secondary">${secondary}</div>` : ""}
      <span class="ops-card__action">${escapeHtml(actionLabel)} <span aria-hidden="true">→</span></span>
    </a>`;
}

export function emptyState(message) {
  return `<div class="dashboard-empty"><span aria-hidden="true">✓</span><p>${escapeHtml(message)}</p></div>`;
}

export function priorityItem(priority) {
  return `
    <a class="priority-item priority-item--${escapeHtml(priority.level)}" href="${escapeHtml(priority.href)}">
      <span class="priority-item__marker" aria-hidden="true"></span>
      <span><strong>${escapeHtml(priority.label)}</strong><small>${escapeHtml(priority.detail)}</small></span>
      <span class="priority-item__arrow" aria-hidden="true">→</span>
    </a>`;
}

export function statusPill(status, label) {
  const positive = ["paid", "received", "delivered", "active"].includes(status);
  const warning = ["ready_to_submit", "ready_for_pickup", "partially_paid", "in_process", "submitted"].includes(status);
  const tone = positive ? "success" : warning ? "warning" : "neutral";
  return `<span class="dashboard-pill dashboard-pill--${tone}">${escapeHtml(label)}</span>`;
}
