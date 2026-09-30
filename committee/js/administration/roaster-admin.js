import { supabase } from "../../assets/supabase-client.js";
import { escapeHtml } from "../components/layout.js";
import { setNotice } from "../master-data/shared.js";

export function roasterPanelMarkup() {
  return `<section id="roaster-panel" class="admin-panel" hidden>
    <div class="panel"><h2>Roaster Email</h2>
      <p class="cell-note">Set the email address for each supplier. A purchase order uses the address for its supplier when you submit it.</p>
      <div id="roaster-settings" class="form-grid"></div>
      <div id="roaster-notice" class="notice" hidden></div>
    </div>
    <div class="panel"><h2>Roaster Funding Payout</h2>
      <p class="cell-note">When enabled, a Coffee Bean may send the amount needed for a submitted purchase order from Stripe to Pack checking. The Pack then pays the roaster separately. Turn this off once Pack debit cards are available.</p>
      <label class="checkbox-field"><input id="roaster-funding-enabled" type="checkbox"><span>Enable Roaster Funding Payout</span></label>
      <div id="roaster-funding-notice" class="notice" hidden></div>
    </div>
  </section>`;
}

export async function initializeRoasterAdmin() {
  const panel = document.querySelector("#roaster-settings");
  const notice = document.querySelector("#roaster-notice");
  const fundingToggle = document.querySelector("#roaster-funding-enabled");
  const fundingNotice = document.querySelector("#roaster-funding-notice");
  const { data: funding, error: fundingError } = await supabase.from("roaster_funding_settings").select("enabled").eq("id",1).single();
  if (fundingError) setNotice(fundingNotice, fundingError.message, "error");
  else fundingToggle.checked = Boolean(funding.enabled);
  fundingToggle.addEventListener("change",async()=>{
    fundingToggle.disabled=true;
    const {data:{user}}=await supabase.auth.getUser();
    const {error}=await supabase.from("roaster_funding_settings")
      .update({enabled:fundingToggle.checked,updated_at:new Date().toISOString(),updated_by:user?.id||null}).eq("id",1);
    if(error)fundingToggle.checked=!fundingToggle.checked;
    setNotice(fundingNotice,error?error.message:fundingToggle.checked?"Roaster funding payouts are enabled.":"Roaster funding payouts are off.",error?"error":"success");
    fundingToggle.disabled=false;
  });
  const [productsResult, settingsResult] = await Promise.all([
    supabase.from("products").select("supplier_name"),
    supabase.from("purchase_order_supplier_settings").select("supplier_name,po_email")
  ]);
  if (productsResult.error || settingsResult.error) {
    setNotice(notice, productsResult.error?.message || settingsResult.error?.message, "error");
    return;
  }
  const saved = new Map(settingsResult.data.map(row => [row.supplier_name.trim().toLowerCase(), row.po_email]));
  const names = [...new Set([...productsResult.data.map(row => row.supplier_name), ...settingsResult.data.map(row => row.supplier_name)]
    .map(name => String(name || "").trim()).filter(Boolean))].sort();
  panel.innerHTML = names.length ? names.map(name => `<form class="portal-form" data-roaster="${escapeHtml(name)}">
    <label class="form-field"><span>${escapeHtml(name)}</span><input type="email" name="po_email" value="${escapeHtml(saved.get(name.toLowerCase()) || "")}" placeholder="roaster@example.com" required></label>
    <button class="portal-button" type="submit">Save Email</button>
  </form>`).join("") : "<p>No suppliers found. Add a product with a supplier first.</p>";
  panel.querySelectorAll("form").forEach(form => form.addEventListener("submit", async event => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) throw new Error("Please sign in again.");
      const { error } = await supabase.from("purchase_order_supplier_settings").upsert({
        supplier_name: form.dataset.roaster,
        po_email: form.elements.po_email.value.trim(),
        updated_by: user.id
      }, { onConflict: "supplier_name" });
      if (error) throw error;
      setNotice(notice, `${form.dataset.roaster} email saved.`, "success");
    } catch (error) { setNotice(notice, error.message, "error"); }
    finally { button.disabled = false; }
  }));
}
