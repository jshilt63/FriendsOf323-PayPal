import { supabase } from "../../assets/supabase-client.js";
import { unwrap } from "./service-utils.js";
import { getOrderWorkflow } from "../shared/order-workflow.js";

const ORDER_SELECT = `
  id,
  order_number,
  ecwid_order_number,
  order_date,
  record_status,
  payment_status,
  wholesaler_status,
  delivery_status,
  amount_paid,
  created_at,
  updated_at,
  customers(first_name,last_name,company_name,email,phone),
  order_items(
    scout_id,
    quantity,
    line_total,
    fundraising_credit_total,
    products(product_name,bag_size,supplier_name),
    scouts(first_name,last_name,is_general_fund,den_id,dens(den_number,current_rank_working_toward))
  )
`;

export const DashboardService = {
  async getDashboard({ includeAudit = false, denId = null } = {}) {
    const requests = [
      supabase.from("orders").select(ORDER_SELECT).order("order_date", { ascending: false }).order("order_number", { ascending: false }),
      supabase.from("scout_summary").select("*").order("available_credit", { ascending: false }),
      supabase.from("scout_credit_transactions")
        .select("id,scout_id,transaction_type,amount,transaction_date,purpose,reference_number,created_at,created_by,scouts(first_name,last_name,is_general_fund,den_id,dens(den_number,current_rank_working_toward))")
        .order("transaction_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(8),
      supabase.from("products").select("id,sku,product_name,supplier_name,supplier_product_name,fundraising_credit_per_unit,is_active"),
      supabase.from("scouts").select("id,first_name,last_name,is_general_fund,den_id,dens(den_number,current_rank_working_toward)"),
      supabase.from("user_profiles").select("id,display_name")
    ];

    if (includeAudit) {
      requests.push(
        supabase.from("audit_log")
          .select("id,table_name,record_id,action,old_data,new_data,changed_by,changed_at")
          .order("changed_at", { ascending: false })
          .limit(12)
      );
    }

    const results = await Promise.all(requests);
    const orders = unwrap(results[0], "Dashboard orders could not be loaded.");
    const scouts = unwrap(results[1], "Scout fundraising totals could not be loaded.");
    const transfers = unwrap(results[2], "Recent transfers could not be loaded.");
    const products = unwrap(results[3], "Product checks could not be loaded.");
    const roster = unwrap(results[4], "Scout den assignments could not be loaded.");
    const profiles = unwrap(results[5], "User names could not be loaded.");
    const audit = includeAudit ? unwrap(results[6], "Recent activity could not be loaded.") : [];

    const profileNames = new Map(profiles.map(row => [row.id, row.display_name]));
    const rosterMap = new Map(roster.map(row => [row.id, row]));
    return buildDashboard({ orders, scouts, transfers, products, audit, profileNames, rosterMap, denId });
  }
};

function buildDashboard({ orders, scouts, transfers, products, audit, profileNames, rosterMap, denId }) {
  const activeOrders = orders
    .filter(order => order.record_status === "active")
    .filter(order => !denId || (order.order_items || []).some(item => item.scouts?.den_id === denId))
    .map(enrichOrder);
  scouts = scouts.filter(row => !denId || rosterMap.get(row.scout_id)?.den_id === denId);
  transfers = transfers.filter(row => !denId || row.scouts?.den_id === denId);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthOrders = activeOrders.filter(order => dateAtMidnight(order.order_date) >= monthStart);
  const unpaidOrders = activeOrders.filter(order => ["unpaid", "partially_paid"].includes(order.payment_status));
  const readyForRoaster = activeOrders.filter(order => getOrderWorkflow(order).key === "roaster");
  const readyForPickup = activeOrders.filter(order => getOrderWorkflow(order).key === "pickup");
  const pendingDelivery = activeOrders.filter(order => order.delivery_status !== "delivered");
  const negativeScouts = scouts.filter(scout => Number(scout.available_credit || 0) < 0);

  // Dashboard sales rankings must be based only on active customer orders.
  // The scout_summary view can retain historical totals from voided/cancelled orders,
  // which caused cancelled bags to appear in Top Scouts.
  const activeScoutSales = new Map();
  for (const order of activeOrders) {
    for (const item of order.order_items || []) {
      const scoutId = item.scout_id;
      if (!scoutId) continue;
      const current = activeScoutSales.get(scoutId) || { bags_sold: 0, active_credit: 0 };
      current.bags_sold += Number(item.quantity || 0);
      current.active_credit += Number(item.fundraising_credit_total || 0);
      activeScoutSales.set(scoutId, current);
    }
  }

  const salesScouts = scouts
    .map(scout => ({ ...scout, ...(activeScoutSales.get(scout.scout_id) || { bags_sold: 0, active_credit: 0 }) }))
    .filter(scout => Number(scout.bags_sold || 0) > 0);

  const topScouts = [...salesScouts]
    .sort((a, b) => Number(b.active_credit || 0) - Number(a.active_credit || 0))
    .slice(0, 5)
    .map(scout => ({
      ...scout,
      available_credit: Number(scout.active_credit || 0),
      scout_name: scoutName(rosterMap.get(scout.scout_id) || scout)
    }));

  const recentTransfers = transfers.map(row => ({
    ...row,
    scout_name: scoutName(row.scouts || {}),
    entered_by: profileNames.get(row.created_by) || null
  }));

  const activity = audit.length
    ? audit.map(row => mapAuditActivity(row, profileNames)).filter(Boolean).slice(0, 8)
    : buildFallbackActivity(activeOrders, recentTransfers).slice(0, 8);

  const oldUnpaid = unpaidOrders.filter(order => daysOld(order.order_date) >= 7);
  const productIssues = products.filter(product => product.is_active && (
    !String(product.supplier_name || "").trim() ||
    Number(product.fundraising_credit_per_unit || 0) <= 0
  ));

  const priorities = [];
  if (unpaidOrders.length) priorities.push({
    level: oldUnpaid.length ? "warning" : "info",
    label: `${unpaidOrders.length} order${plural(unpaidOrders.length)} awaiting payment`,
    detail: `${money(sum(unpaidOrders, "outstanding"))} outstanding${oldUnpaid.length ? `; ${oldUnpaid.length} at least 7 days old` : ""}`,
    href: "/committee/orders.html?workflow=payment"
  });
  if (readyForRoaster.length) priorities.push({
    level: "info",
    label: `${sum(readyForRoaster, "bags")} bag${plural(sum(readyForRoaster, "bags"))} ready to order from roaster`,
    detail: `${readyForRoaster.length} customer order${plural(readyForRoaster.length)}`,
    href: "/committee/ready-to-order.html"
  });
  if (readyForPickup.length) priorities.push({
    level: "success",
    label: `${readyForPickup.length} order${plural(readyForPickup.length)} ready for pickup`,
    detail: `${sum(readyForPickup, "bags")} bag${plural(sum(readyForPickup, "bags"))} waiting for customers`,
    href: "/committee/orders.html?workflow=pickup"
  });
  if (negativeScouts.length) priorities.push({
    level: "danger",
    label: `${negativeScouts.length} scout balance${plural(negativeScouts.length)} below zero`,
    detail: "Review transfers or ledger adjustments.",
    href: "/committee/fundraising.html"
  });
  if (productIssues.length) priorities.push({
    level: "warning",
    label: `${productIssues.length} active product${plural(productIssues.length)} need setup review`,
    detail: "Missing supplier information or fundraising credit.",
    href: "/committee/products.html"
  });

  return {
    generatedAt: new Date().toISOString(),
    operations: {
      awaitingPayment: {
        orders: unpaidOrders.length,
        amount: sum(unpaidOrders, "outstanding"),
        oldOrders: oldUnpaid.length
      },
      readyForRoaster: {
        orders: readyForRoaster.length,
        bags: sum(readyForRoaster, "bags"),
        suppliers: supplierBreakdown(readyForRoaster)
      },
      readyForPickup: {
        orders: readyForPickup.length,
        bags: sum(readyForPickup, "bags")
      },
      pendingDelivery: {
        orders: pendingDelivery.length,
        amount: sum(pendingDelivery, "total")
      },
      fundraising: {
        available: sum(scouts, "available_credit"),
        scouts: salesScouts.length
      },
      monthlySales: {
        amount: sum(monthOrders, "total"),
        bags: sum(monthOrders, "bags"),
        monthLabel: now.toLocaleDateString("en-US", { month: "long", year: "numeric" })
      }
    },
    recentOrders: activeOrders.slice(0, 8),
    topScouts,
    recentTransfers,
    activity,
    priorities
  };
}

function enrichOrder(order) {
  const items = order.order_items || [];
  const total = items.reduce((value, item) => value + Number(item.line_total || 0), 0);
  const bags = items.reduce((value, item) => value + Number(item.quantity || 0), 0);
  const amountPaid = Number(order.amount_paid || 0);
  return {
    ...order,
    customer_name: customerName(order.customers),
    total,
    bags,
    outstanding: Math.max(0, total - amountPaid),
    scout_names: [...new Set(items.map(item => scoutName(item.scouts || {})).filter(Boolean))]
  };
}

function supplierBreakdown(orders) {
  const result = new Map();
  for (const order of orders) {
    for (const item of order.order_items || []) {
      const supplier = String(item.products?.supplier_name || "Unassigned").trim() || "Unassigned";
      result.set(supplier, (result.get(supplier) || 0) + Number(item.quantity || 0));
    }
  }
  return [...result.entries()]
    .map(([supplier, bags]) => ({ supplier, bags }))
    .sort((a, b) => b.bags - a.bags);
}

function mapAuditActivity(row, profileNames) {
  const tableLabels = {
    orders: "Order",
    order_items: "Order item",
    customers: "Customer",
    scouts: "Scout",
    products: "Product",
    scout_credit_transactions: "Fundraising transaction",
    user_profiles: "Portal user"
  };
  const label = tableLabels[row.table_name] || row.table_name;
  const actor = profileNames.get(row.changed_by) || "System";
  const action = row.action === "INSERT" ? "created" : row.action === "DELETE" ? "deleted" : describeUpdate(row);
  return {
    id: row.id,
    title: `${label} ${action}`,
    detail: auditDetail(row),
    actor,
    changed_at: row.changed_at
  };
}

function describeUpdate(row) {
  if (row.table_name === "orders") {
    if (row.old_data?.record_status !== row.new_data?.record_status) {
      return row.new_data?.record_status === "voided" ? "voided" : "restored";
    }
    if (row.old_data?.payment_status !== row.new_data?.payment_status) return "payment updated";
    if (row.old_data?.wholesaler_status !== row.new_data?.wholesaler_status) return "roaster status updated";
    if (row.old_data?.delivery_status !== row.new_data?.delivery_status) return "delivery status updated";
  }
  return "updated";
}

function auditDetail(row) {
  const data = row.new_data || row.old_data || {};
  if (row.table_name === "orders" && data.order_number) return `Order #${data.order_number}`;
  if (row.table_name === "scout_credit_transactions") {
    return `${money(data.amount || 0)}${data.purpose ? ` — ${data.purpose}` : ""}`;
  }
  if (data.product_name) return data.product_name;
  if (data.first_name || data.last_name) return [data.first_name, data.last_name].filter(Boolean).join(" ");
  return row.record_id ? `Record ${String(row.record_id).slice(0, 8)}` : "";
}

function buildFallbackActivity(orders, transfers) {
  const orderRows = orders.slice(0, 6).map(order => ({
    id: `order-${order.id}`,
    title: `Order #${order.order_number}`,
    detail: `${order.customer_name} — ${money(order.total)}`,
    actor: "Order activity",
    changed_at: order.updated_at || order.created_at
  }));
  const transferRows = transfers.slice(0, 6).map(row => ({
    id: `transfer-${row.id}`,
    title: row.transaction_type === "transfer_to_pack" ? "Transfer to pack" : "Ledger adjustment",
    detail: `${row.scout_name} — ${money(row.amount)}${row.purpose ? ` — ${row.purpose}` : ""}`,
    actor: row.entered_by || "Fundraising activity",
    changed_at: row.created_at
  }));
  return [...orderRows, ...transferRows]
    .sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at));
}

function customerName(customer) {
  const person = [customer?.first_name, customer?.last_name].filter(Boolean).join(" ");
  return person || customer?.company_name || "Unnamed Customer";
}
function scoutName(scout) {
  if (scout?.is_general_fund) return "General Fund";
  const name = [scout?.first_name, scout?.last_name].filter(Boolean).join(" ") || "Unknown Scout";
  return scout?.dens?.den_number
    ? `${name} — Den ${scout.dens.den_number} · ${scout.dens.current_rank_working_toward}`
    : `${name} — No den assigned`;
}
function dateAtMidnight(value) { return new Date(`${value}T00:00:00`); }
function daysOld(value) { return Math.floor((Date.now() - dateAtMidnight(value).getTime()) / 86400000); }
function sum(rows, key) { return rows.reduce((total, row) => total + Number(row[key] || 0), 0); }
function money(value) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value || 0)); }
function plural(count) { return Number(count) === 1 ? "" : "s"; }
