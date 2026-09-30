import { requirePortalUser } from "../../assets/auth-common.js";
import { renderPortalLayout,escapeHtml } from "../components/layout.js?v=1.9.0";
import { FundraisingService } from "../services/fundraising-service.js";
import { money,setNotice } from "../master-data/shared.js";

const result=await requirePortalUser();if(result)initialize(result);
async function initialize({user,profile}){
  const content=renderPortalLayout({profile,user,pageTitle:'Treasurer Payout Report'});
  const id=new URLSearchParams(location.search).get('id');
  content.innerHTML=`<div class="breadcrumb"><a href="/committee/transfers.html">Transfers</a> / Treasurer Report</div><div class="page-heading print-hide"><div><h1>Treasurer Payout Report</h1><p>Scout credits applied from Pack bank deposits and Stripe payouts.</p></div><div class="page-heading__actions"><a class="portal-button portal-button--secondary" href="/committee/transfers.html">Back to Transfers</a><button class="portal-button" id="print-report">Print / Save PDF</button></div></div><div id="page-notice" class="notice" hidden></div><section id="report" class="panel payout-report-sheet"></section>`;
  const notice=document.querySelector('#page-notice');
  if(!id)return setNotice(notice,'Payout ID is missing.','error');
  try{
    const rows=await FundraisingService.payoutReport(id);
    if(!rows.length)return setNotice(notice,'Payout report was not found.','error');
    const p=rows[0];
    document.querySelector('#report').innerHTML=`
      <div class="treasurer-report-header"><div><div class="section-eyebrow">Friends of 323</div><h1>Scout Credit Transfer Report</h1></div><div class="report-transfer-number">${escapeHtml(p.payout_number)}</div></div>
      <div class="report-summary-grid">
        <div><span>Purpose</span><strong>${escapeHtml(p.purpose)}</strong></div>
        <div><span>Total Payout</span><strong>${money(p.total_amount)}</strong></div>
        <div><span>Already in Pack Checking</span><strong>${money(p.bank_offset_amount)}</strong></div>
        <div><span>Sent from Stripe</span><strong>${money(p.stripe_amount)}</strong></div>
        <div><span>Status</span><strong>${escapeHtml(statusLabel(p.status))}</strong></div>
        <div><span>Created</span><strong>${formatDate(p.created_at)}</strong></div>
        <div><span>Expected / Arrival</span><strong>${p.stripe_arrival_date?formatDate(p.stripe_arrival_date):'—'}</strong></div>
        <div><span>Stripe Payout ID</span><strong class="report-small">${escapeHtml(p.stripe_payout_id||'—')}</strong></div>
      </div>
      <table class="treasurer-table"><thead><tr><th>Scout</th><th>Parent / Guardian</th><th>Purpose</th><th class="amount-column">Amount Applied</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml([r.scout_first_name,r.scout_last_name].filter(Boolean).join(' '))}</td><td>${escapeHtml([r.guardian_first_name,r.guardian_last_name].filter(Boolean).join(' ')||'—')}</td><td>${escapeHtml(r.purpose)}</td><td class="amount-column">${money(r.amount)}</td></tr>`).join('')}<tr class="report-total-row"><td colspan="3">Total</td><td class="amount-column">${money(p.total_amount)}</td></tr></tbody></table>
      <p class="report-footnote">The total Scout credit above is funded by deposits already in Pack checking plus any Stripe payout shown here.</p>`;
    document.querySelector('#print-report').onclick=()=>window.print();
  }catch(error){setNotice(notice,error.message,'error')}
}
function statusLabel(v){return({draft:'Preparing',submitted:'Payout Pending',paid:'Paid',failed:'Failed',canceled:'Canceled'})[v]||v}
function formatDate(v){if(!v)return'—';const d=new Date(String(v).length===10?`${v}T00:00:00`:v);return Number.isNaN(d.getTime())?'—':d.toLocaleDateString()}
