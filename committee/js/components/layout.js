import { signOut } from "../../assets/auth-common.js";
import { ROLE_LABELS, hasMinimumRole } from "../shared/roles.js";

const nav = [
  ["Dashboard", "/committee/dashboard.html", "committee_member"],
  ["Orders", "/committee/orders.html", "committee_member"],
  ["Roaster", "/committee/ready-to-order.html", "committee_member"],
  ["Scouts", "/committee/scouts.html", "committee_member"],
  ["Bean Counter", "/committee/treasury.html", "treasurer"],
  ["Administration", "/committee/administration.html", "coffee_bean"]
];

const sectionTabs = {
  Orders: [
    ["Orders", "/committee/orders.html"],
    ["Customers", "/committee/customers.html"]
  ],
  Roaster: [
    ["Roaster Orders", "/committee/ready-to-order.html"],
    ["Purchase Orders", "/committee/purchase-orders.html"]
  ],
  Scouts: [
    ["Scout Roster", "/committee/scouts.html"],
    ["Fundraising", "/committee/fundraising.html"],
    ["Transfers", "/committee/transfers.html"]
  ],
  Administration: [
    ["Users", "/committee/administration.html?tab=users"],
    ["Drivers", "/committee/administration.html?tab=drivers"],
    ["Shipping", "/committee/administration.html?tab=shipping"],
    ["Store Notice", "/committee/administration.html?tab=store-notice"],
    ["Roaster", "/committee/administration.html?tab=roaster"],
    ["Bank Deposits", "/committee/administration.html?tab=funds"],
    ["Products", "/committee/products.html"],
    ["Reports", "/committee/reports.html"],
    ["Audit", "/committee/administration.html?tab=audit"]
  ]
};

function sectionForPage(pageTitle) {
  if (pageTitle === "Bean Counter") return "Bean Counter";
  if (["Orders", "Customers"].includes(pageTitle)) return "Orders";
  if (["Ready to Order", "Roaster", "Purchase Orders", "Purchase Order"].includes(pageTitle)) return "Roaster";
  if (["Scouts", "Fundraising", "Transfers", "Scout Ledger", "Treasurer Payout Report"].includes(pageTitle)) return "Scouts";
  if (["Administration", "Products", "Reports"].includes(pageTitle)) return "Administration";
  return "Dashboard";
}

function renderSectionTabs(section) {
  if (section === "Dashboard" || section === "Bean Counter") return "";
  const currentPath = window.location.pathname;
  const currentTab = new URLSearchParams(window.location.search).get("tab") || "users";
  return `<nav class="section-tabs" aria-label="${section} sections">
    ${sectionTabs[section].map(([label, url]) => {
      const target = new URL(url, window.location.origin);
      let active = target.pathname === currentPath;
      if (section === "Administration" && target.pathname.endsWith("administration.html") && currentPath.endsWith("administration.html")) {
        active = (target.searchParams.get("tab") || "users") === currentTab;
      }
      return `<a href="${url}" ${active ? 'aria-current="page"' : ""}>${label}</a>`;
    }).join("")}
  </nav>`;
}

export function renderPortalLayout({ profile, user, pageTitle = "Dashboard" }) {
  const app = document.querySelector("#portal-app");
  const role = profile.role;
  const activeSection = sectionForPage(pageTitle);

  app.innerHTML = `
    <aside class="portal-sidebar" id="portal-sidebar">
      <div class="portal-brand">
        <p class="portal-brand__eyebrow">Friends of 323</p>
        <p class="portal-brand__title">Coffee Portal</p>
      </div>
      <nav class="portal-nav" aria-label="Portal navigation">
        ${nav.map(([label, url, minimumRole]) =>
          (minimumRole === "treasurer" ? ["treasurer","coffee_bean"].includes(role) : hasMinimumRole(role, minimumRole))
            ? `<a href="${url}"
                  ${url === "#" ? 'data-disabled="true" aria-disabled="true"' : ""}
                  ${label === activeSection ? 'aria-current="page"' : ""}>${label}</a>`
            : ""
        ).join("")}
      </nav>
      <div class="portal-sidebar__footer">
        <a class="portal-main-site-link" href="/" aria-label="Return to the Friends of 323 main site">
          <span class="brand_mountain" aria-hidden="true"></span>
          <span class="portal-main-site-link__text">Back to Main Site</span>
        </a>
      </div>
    </aside>
    <button class="portal-sidebar-backdrop" id="portal-sidebar-backdrop" type="button"
            aria-label="Close navigation menu" tabindex="-1"></button>
    <div class="portal-main">
      <header class="portal-header">
        <div class="portal-header__left">
          <button class="portal-button portal-button--secondary mobile-menu"
                  id="mobile-menu" type="button" aria-controls="portal-sidebar"
                  aria-expanded="false" aria-label="Open navigation menu">
            <span class="mobile-menu__icon" aria-hidden="true"><span></span><span></span><span></span></span>
            <span class="mobile-menu__label">Menu</span>
          </button>
          <h2 class="portal-header__title">${escapeHtml(pageTitle)}</h2>
        </div>
        <div class="portal-user">
          <div class="portal-user__text">
            <div class="portal-user__name">${escapeHtml(profile.display_name || user.email)}</div>
            <div class="portal-user__role">${ROLE_LABELS[role] || role}</div>
          </div>
          <button class="portal-button" id="sign-out" type="button">Sign out</button>
        </div>
      </header>
      <main class="portal-content">
        ${renderSectionTabs(activeSection)}
        <div id="portal-content"></div>
      </main>
    </div>`;

  app.className = "portal-app";

  document.querySelector("#sign-out").addEventListener("click", signOut);

  const sidebar = document.querySelector("#portal-sidebar");
  const menuButton = document.querySelector("#mobile-menu");
  const backdrop = document.querySelector("#portal-sidebar-backdrop");

  const setMenuOpen = open => {
    if (!sidebar || !menuButton) return;
    sidebar.classList.toggle("is-open", open);
    backdrop?.classList.toggle("is-open", open);
    document.body.classList.toggle("portal-menu-open", open);
    menuButton.setAttribute("aria-expanded", String(open));
    menuButton.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
  };

  const toggleMenu = event => {
    event?.preventDefault();
    setMenuOpen(!sidebar?.classList.contains("is-open"));
  };

  // Use a single click handler. On iOS Safari a tap can fire both touchend and
  // a synthetic click; registering both handlers toggles the menu open and then
  // immediately closed, which makes the button appear unresponsive.
  menuButton?.addEventListener("click", toggleMenu);
  backdrop?.addEventListener("click", () => setMenuOpen(false));
  sidebar?.querySelectorAll("a").forEach(link => link.addEventListener("click", () => setMenuOpen(false)));
  window.addEventListener("keydown", event => {
    if (event.key === "Escape") setMenuOpen(false);
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 720) setMenuOpen(false);
  });

  document.querySelectorAll('[data-disabled="true"]').forEach(link => {
    link.addEventListener("click", event => event.preventDefault());
  });

  return document.querySelector("#portal-content");
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  }[character]));
}
