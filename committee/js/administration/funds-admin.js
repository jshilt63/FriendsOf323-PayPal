import { supabase } from "../../assets/supabase-client.js";
import { escapeHtml } from "../components/layout.js";
import { setNotice } from "../master-data/shared.js";

const money = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value || 0));
const date = value => value ? new Date(value).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" }) : "—";

export function fundsPanelMarkup() {
  return `<section id="funds-panel" class="admin-panel" hidden>
    <div class="panel">
      <h2>Pack Bank Deposits</h2>
      <p class="cell-note">Record cash or Venmo received by the Treasurer and deposited into Pack checking. These are funds already in Pack checking; retain their deposit references for reconciliation.</p>
      <div id="funds-notice" class="notice" hidden></div>
      <div id="funds-orders"></div>
      <form id="funding-transfer-form" class="portal-form">
        <label class="form-field"><span>Bank deposit reference</span><input name="bank_reference" required maxlength="180" placeholder="Deposit slip or Treasurer reference"></label>
        <button class="portal-button" type="submit">Record Pack Bank Deposit</button>
      </form>
      <h3>Deposit History</h3><div id="funding-transfers"></div>
    </div>
  </section>`;
}

export async function initializeFundsAdmin() {
  const notice = document.querySelector("#funds-notice");
  const list = document.querySelector("#funds-orders");
  const transfers = document.querySelector("#funding-transfers");
  const form = document.querySelector("#funding-transfer-form");

  async function load() {
    const [ordersResult, trackingResult, depositsResult, allocationsResult, payoutsResult] = await Promise.all([
      supabase.from("orders").select("id,order_number,processing_cost,shipping_amount,payment_status,payment_method,payment_provider,record_status,order_items(line_total)").eq("payment_status", "paid").eq("record_status", "active").order("order_number", { ascending: false }),
      supabase.from("order_funding_tracking").select("order_id,treasurer_received_at,bank_deposit_id"),
      supabase.from("pack_bank_deposits").select("id,amount,reference,deposited_at").order("deposited_at", { ascending: false }),
      supabase.from("pack_bank_deposit_allocations").select("deposit_id,payout_id,amount"),
      supabase.from("credit_payouts").select("id,status")
    ]);
    const error = ordersResult.error || trackingResult.error || depositsResult.error || allocationsResult.error || payoutsResult.error;
    if (error) { setNotice(notice, error.message, "error"); return; }
    const tracked = new Map(trackingResult.data.map(row => [row.order_id, row]));
    const rows = ordersResult.data.filter(order => ["cash", "venmo"].includes(String(order.payment_method || order.payment_provider || "").toLowerCase()))
      .map(order => ({ ...order, order_total: (order.order_items || []).reduce((total, item) => total + Number(item.line_total || 0), 0) + Number(order.processing_cost || 0) + Number(order.shipping_amount || 0) }));
    list.innerHTML = rows.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Select</th><th>Order</th><th>Method</th><th>Amount</th><th>Treasurer received</th><th>Pack bank deposit</th></tr></thead><tbody>${rows.map(order => {
      const tracking = tracked.get(order.id);
      return `<tr><td>${tracking && !tracking.bank_deposit_id ? `<input type="checkbox" data-fund-order="${order.id}" aria-label="Include order ${escapeHtml(order.order_number)}">` : ""}</td>
        <td>#${escapeHtml(order.order_number)}</td><td>${escapeHtml(order.payment_method || order.payment_provider)}</td><td>${money(order.order_total)}</td>
        <td>${tracking ? date(tracking.treasurer_received_at) : `<button type="button" class="portal-button portal-button--secondary" data-treasurer-received="${order.id}">Record Receipt</button>`}</td>
        <td>${tracking?.bank_deposit_id ? "Deposited" : "Waiting"}</td></tr>`;
    }).join("")}</tbody></table></div>` : `<div class="funds-empty-state"><strong>No cash or Venmo payments are ready yet.</strong><p>After you record a customer's cash or Venmo payment on the <a href="/committee/orders.html">Orders page</a>, it will appear here for Treasurer receipt and transfer tracking.</p></div>`;
    form.hidden = !rows.some(order => tracked.has(order.id) && !tracked.get(order.id).bank_deposit_id);
    const activePayouts = new Set(payoutsResult.data.filter(row => ["draft", "submitted", "paid"].includes(row.status)).map(row => row.id));
    const allocated = new Map();
    allocationsResult.data.filter(row => activePayouts.has(row.payout_id)).forEach(row => allocated.set(row.deposit_id, (allocated.get(row.deposit_id) || 0) + Number(row.amount)));
    transfers.innerHTML = depositsResult.data.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Deposited</th><th>Amount</th><th>Reference</th><th>Applied to historical transfers</th></tr></thead><tbody>${depositsResult.data.map(row => `<tr><td>${date(row.deposited_at)}</td><td>${money(row.amount)}</td><td>${escapeHtml(row.reference)}</td><td>${money(allocated.get(row.id) || 0)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="funds-empty-state"><strong>No Pack bank deposits recorded yet.</strong><p>Confirm the Treasurer has received a paid cash or Venmo order, then enter the checking account deposit reference above.</p></div>`;
  }

  list.addEventListener("click", async event => {
    const button = event.target.closest("[data-treasurer-received]");
    if (!button || !window.confirm("Has the Treasurer received this cash or Venmo payment?")) return;
    button.disabled = true;
    const { error } = await supabase.rpc("record_treasurer_receipt", { p_order_id: button.dataset.treasurerReceived });
    setNotice(notice, error ? error.message : "Treasurer receipt recorded.", error ? "error" : "success");
    await load();
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const ids = [...list.querySelectorAll("[data-fund-order]:checked")].map(input => input.dataset.fundOrder);
    if (!ids.length) { setNotice(notice, "Select at least one order received by the Treasurer.", "error"); return; }
    const button = form.querySelector('button[type="submit"]'); button.disabled = true;
    const { error } = await supabase.rpc("record_pack_bank_deposit", { p_order_ids: ids, p_reference: form.elements.bank_reference.value.trim() });
    if (!error) form.reset();
    setNotice(notice, error ? error.message : "Pack bank deposit recorded. Record any completed Scout credit allocation on the Transfers page.", error ? "error" : "success");
    button.disabled = false; await load();
  });

  await load();
  return { load };
}
