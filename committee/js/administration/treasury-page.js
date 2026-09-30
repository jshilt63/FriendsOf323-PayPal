import { requirePortalUser } from "../../assets/auth-common.js";
import { supabase } from "../../assets/supabase-client.js";
import { renderPortalLayout, escapeHtml } from "../components/layout.js?v=1.9.32";
import { fundsPanelMarkup, initializeFundsAdmin } from "./funds-admin.js?v=1.9.32";
import { setNotice } from "../master-data/shared.js";

const result = await requirePortalUser({allowedRoles:["treasurer","coffee_bean"]});
if (result) {
  const content=renderPortalLayout({...result,pageTitle:"Bean Counter"});
  content.innerHTML=`<div class="breadcrumb">Committee Portal / Bean Counter</div><div class="page-heading"><div><h1>Bean Counter</h1><p>Confirm customer cash and Venmo payments, then track deposits into Pack checking.</p></div></div>
    <section class="panel"><h2>Payments to Confirm</h2><div id="treasury-payment-notice" class="notice" hidden></div><div id="treasury-unpaid"></div></section>${fundsPanelMarkup()}`;
  document.querySelector("#funds-panel").hidden=false;
  const notice=document.querySelector("#treasury-payment-notice");
  const target=document.querySelector("#treasury-unpaid");
  async function loadUnpaid() {
    const {data,error}=await supabase.from("orders")
      .select("id,order_number,payment_method,payment_provider,processing_cost,shipping_amount,order_items(line_total)")
      .eq("payment_status","unpaid").eq("record_status","active").order("order_number",{ascending:false});
    if(error){setNotice(notice,error.message,"error");return;}
    target.innerHTML=data.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Order</th><th>Amount</th><th>Received by Treasurer</th><th>Action</th></tr></thead><tbody>${data.map(order=>{
      const total=(order.order_items||[]).reduce((sum,item)=>sum+Number(item.line_total||0),0)+Number(order.processing_cost||0)+Number(order.shipping_amount||0);
      const method=String(order.payment_method||order.payment_provider||"").toLowerCase();
      return `<tr><td>#${escapeHtml(order.order_number)}</td><td>${new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(total)}</td><td><select aria-label="Payment method for order ${escapeHtml(order.order_number)}" data-method><option value="">Choose method</option><option value="cash" ${method==="cash"?"selected":""}>Cash</option><option value="venmo" ${method==="venmo"?"selected":""}>Venmo</option></select></td><td><button class="portal-button" type="button" data-confirm-order="${order.id}">Confirm Received</button></td></tr>`;
    }).join("")}</tbody></table></div>`:`<div class="funds-empty-state"><strong>No unpaid orders to confirm.</strong><p>Paid cash and Venmo orders appear in the deposit section below.</p></div>`;
  }
  target.addEventListener("click",async event=>{
    const button=event.target.closest("[data-confirm-order]");if(!button)return;
    const method=button.closest("tr").querySelector("[data-method]").value;
    if(!method){setNotice(notice,"Choose Cash or Venmo before confirming receipt.","error");return;}
    if(!window.confirm(`Confirm the Treasurer received the full ${method} payment for this order?`))return;
    button.disabled=true;
    const {error}=await supabase.rpc("treasurer_confirm_order_payment",{p_order_id:button.dataset.confirmOrder,p_method:method});
    setNotice(notice,error?error.message:`${method==="cash"?"Cash":"Venmo"} received. Order marked paid and ready for the roaster.`,error?"error":"success");
    await loadUnpaid();
    if(!error) await funds.load();
  });
  await loadUnpaid();
  const funds=await initializeFundsAdmin();
}
