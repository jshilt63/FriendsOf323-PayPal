import { requirePortalUser } from "../../assets/auth-common.js";
import { renderPortalLayout,escapeHtml } from "../components/layout.js?v=1.9.32";
import { DataGrid } from "../components/data-grid.js";
import { confirmAction } from "../components/confirm-dialog.js?v=1.9.4";
import { FundraisingService } from "../services/fundraising-service.js";
import { hasMinimumRole } from "../shared/roles.js";
import { clearNotice,closeDialog,money,normalizeNullable,openDialog,setFormBusy,setNotice } from "../master-data/shared.js";

const result=await requirePortalUser();
if(result)initialize(result);

async function initialize({user,profile}){
  const canManage=hasMinimumRole(profile.role,'coffee_bean');
  const content=renderPortalLayout({profile,user,pageTitle:'Transfers'});
  content.innerHTML=`
    <div class="breadcrumb">Committee Portal / Transfers</div>
    <div class="page-heading"><div><h1>Scout Credit Transfers</h1><p>Select the scouts and amounts to send to the Pack bank account through Stripe.</p></div>
      <div class="page-heading__actions">${canManage?'<button id="new-payout" class="portal-button">Create Pack Payout</button><button id="new-transaction" class="portal-button portal-button--secondary">Record Adjustment</button>':'<span class="status-badge status-badge--info">Read only</span>'}</div>
    </div>
    <div id="page-notice" class="notice" hidden></div>
    <section class="panel"><div class="section-heading-inline"><div><h2>Pack Payout History</h2><p>Stripe payouts and the scout credits included in each deposit.</p></div></div><div id="payouts-grid"></div></section>
    <section class="panel"><div class="section-heading-inline"><div><h2>Credit Transactions</h2><p>Individual payout lines, opening balances, and approved adjustments.</p></div></div><div id="transactions-grid"></div></section>
    ${canManage?payoutDialog()+adjustmentDialog():''}`;

  let scouts=[],summary=[],transactions=[],payouts=[];
  const notice=document.querySelector('#page-notice');

  const payoutGrid=new DataGrid({
    container:'#payouts-grid',
    columns:[
      {key:'created_at',label:'Date',render:r=>new Date(r.created_at).toLocaleDateString()},
      {key:'payout_number',label:'Transfer',render:r=>`<strong>${escapeHtml(r.payout_number)}</strong>`},
      {key:'purpose',label:'Purpose',render:r=>escapeHtml(r.purpose)},
      {key:'total_amount',label:'Amount',render:r=>money(r.total_amount)},
      {key:'bank_offset_amount',label:'Already in Bank',render:r=>money(r.bank_offset_amount)},
      {key:'stripe_amount',label:'From Stripe',render:r=>money(r.stripe_amount)},
      {key:'status',label:'Status',render:r=>statusBadge(r.status)},
      {key:'stripe_payout_id',label:'Stripe',render:r=>escapeHtml(r.stripe_payout_id||'—')},
      {key:'report',label:'Treasurer Report',sortable:false,render:r=>`<a class="table-action" href="/committee/payout-report.html?id=${encodeURIComponent(r.id)}">View Report</a>`}
    ],
    searchFields:['payout_number','purpose','status','stripe_payout_id'],
    exportFileName:'friends-323-payout-history.csv'
  });

  const transactionGrid=new DataGrid({
    container:'#transactions-grid',
    columns:[
      {key:'transaction_date',label:'Date',render:r=>new Date(`${r.transaction_date}T00:00:00`).toLocaleDateString()},
      {key:'scout_name',label:'Scout'},{key:'type_label',label:'Type'},
      {key:'amount',label:'Amount',render:r=>money(r.amount)},
      {key:'purpose',label:'Purpose',render:r=>escapeHtml(r.purpose||'—')},
      {key:'reference_number',label:'Reference',render:r=>escapeHtml(r.reference_number||'—')},
      {key:'entered_by',label:'Entered By',render:r=>escapeHtml(r.entered_by||'—')}
    ],
    searchFields:['scout_name','type_label','purpose','reference_number','entered_by'],
    exportFileName:'friends-323-credit-transactions.csv',
    filters:[{key:'type',label:'Type',type:'select',options:[{value:'all',label:'All transactions'},{value:'transfer_to_pack',label:'Paid to Pack'},{value:'opening_balance',label:'Opening Balances'},{value:'adjustment_credit',label:'Credit Adjustments'},{value:'adjustment_debit',label:'Debit Adjustments'}],defaultValue:'all',predicate:(r,v)=>v==='all'||r.transaction_type===v}]
  });

  async function load(){
    try{
      [scouts,summary,transactions,payouts]=await Promise.all([FundraisingService.scouts(),FundraisingService.summary(),FundraisingService.transactions(),FundraisingService.payouts()]);
      transactionGrid.setRows(transactions.map(r=>({...r,scout_name:name(r.scouts),type_label:label(r.transaction_type),entered_by:r.entered_by})));
      payoutGrid.setRows(payouts);
    }catch(error){setNotice(notice,error.message,'error')}
  }

  if(canManage){
    setupPayoutDialog();
    setupAdjustmentDialog();
  }
  await load();
  if(new URLSearchParams(window.location.search).get('action')==='new'&&canManage)document.querySelector('#new-payout')?.click();

  function setupPayoutDialog(){
    const d=document.querySelector('#payout-dialog');
    const f=document.querySelector('#payout-form');
    const fn=document.querySelector('#payout-form-notice');
    const list=document.querySelector('#payout-scout-list');
    const total=document.querySelector('#payout-total');
    const availableEl=document.querySelector('#stripe-available-balance');
    const arrivalEl=document.querySelector('#stripe-estimated-arrival');
    const balanceStatus=document.querySelector('#stripe-balance-status');
    const balanceWarning=document.querySelector('#stripe-balance-warning');
    const submitButton=f.querySelector('button[type="submit"]');
    let stripeAvailable=null,bankAvailable=0;
    const bankInput=f.querySelector('[name="bank_offset_amount"]');
    const bankAvailableEl=f.querySelector('#bank-deposit-available');
    const stripeAmountEl=f.querySelector('#stripe-payout-amount');

    document.querySelector('#new-payout').onclick=async()=>{
      f.reset();clearNotice(fn);
      stripeAvailable=null;
      bankAvailable=0; bankInput.value='0.00'; bankAvailableEl.textContent='Loading…';
      availableEl.textContent='Loading…';
      arrivalEl.textContent='Loading…';
      balanceStatus.textContent='Checking live Stripe balance…';
      balanceWarning.hidden=true;
      const eligible=summary.filter(r=>!r.is_general_fund && Number(r.available_credit)>0.004);
      list.innerHTML=eligible.length?eligible.map(r=>`
        <div class="payout-scout-row" data-scout-id="${r.scout_id}" data-available="${Number(r.available_credit).toFixed(2)}">
          <label class="payout-scout-select"><input type="checkbox" data-select> <span><strong>${escapeHtml([r.first_name,r.last_name].filter(Boolean).join(' '))}</strong><small>Available ${money(r.available_credit)}</small></span></label>
          <label class="payout-amount-field"><span>Transfer</span><input type="number" min="0" max="${Number(r.available_credit).toFixed(2)}" step="0.01" value="${Number(r.available_credit).toFixed(2)}" data-amount disabled></label>
          <div class="payout-remaining"><span>Remaining</span><strong data-remaining>${money(r.available_credit)}</strong></div>
        </div>`).join(''):'<div class="dashboard-empty"><p>No scouts currently have credit available to transfer.</p></div>';
      bindPayoutRows();updatePayoutTotal();openDialog(d);
      const [stripeResult,bankResult]=await Promise.allSettled([FundraisingService.payoutInfo(),FundraisingService.bankDepositsAvailable()]);
      if(bankResult.status==='fulfilled') {
        bankAvailable=Number(bankResult.value||0); bankAvailableEl.textContent=money(bankAvailable);
      } else {
        bankAvailableEl.textContent='Unavailable';
        setNotice(fn,bankResult.reason.message,'error');
      }
      if(stripeResult.status==='fulfilled') {
        const info=stripeResult.value;
        stripeAvailable=Number(info.available_usd||0);
        availableEl.textContent=money(stripeAvailable);
        arrivalEl.textContent=info.estimated_arrival_date
          ? new Date(`${info.estimated_arrival_date}T12:00:00`).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})
          : 'Calculated after payout';
        balanceStatus.textContent=info.estimate_note||'Stripe confirms the exact arrival date after the payout is created.';
      }else{
        stripeAvailable=null;
        availableEl.textContent='Unavailable';
        arrivalEl.textContent='Unavailable';
        balanceStatus.textContent=stripeResult.reason.message;
      }
      updatePayoutTotal();
    };
    d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>closeDialog(d));

    function bindPayoutRows(){
      list.querySelectorAll('.payout-scout-row').forEach(row=>{
        const checkbox=row.querySelector('[data-select]');
        const amount=row.querySelector('[data-amount]');
        checkbox.onchange=()=>{amount.disabled=!checkbox.checked;updateRow(row);updatePayoutTotal();};
        amount.oninput=()=>{updateRow(row);updatePayoutTotal();};
      });
    }
    function updateRow(row){
      const available=Number(row.dataset.available||0),checked=row.querySelector('[data-select]').checked;
      let amount=checked?Number(row.querySelector('[data-amount]').value||0):0;
      if(amount>available){amount=available;row.querySelector('[data-amount]').value=available.toFixed(2)}
      row.querySelector('[data-remaining]').textContent=money(Math.max(0,available-amount));
    }
    function updatePayoutTotal(){
      const amount=[...list.querySelectorAll('.payout-scout-row')].reduce((sum,row)=>row.querySelector('[data-select]').checked?sum+Number(row.querySelector('[data-amount]').value||0):sum,0);
      total.textContent=money(amount);
      const offset=Number(bankInput.value||0);
      const validOffset=Number.isFinite(offset)&&offset>=0&&offset<=amount+0.004&&offset<=bankAvailable+0.004;
      const stripeAmount=Math.max(0,amount-offset);
      stripeAmountEl.textContent=money(stripeAmount);
      const hasEligible=list.querySelectorAll('.payout-scout-row').length>0;
      const overBalance=Number.isFinite(stripeAvailable) && stripeAmount>stripeAvailable+0.004;
      submitButton.disabled=!hasEligible || amount<=0.004 || !validOffset || overBalance || (stripeAmount>0.004 && stripeAvailable===null);
      submitButton.title=overBalance
        ? `Stripe payout ${money(stripeAmount)} exceeds Stripe's available balance of ${money(stripeAvailable)}.`
        : !validOffset ? 'Bank offset must be no more than the selected credit and deposited funds.' : '';
      balanceWarning.hidden=!overBalance&&!validOffset;
      if(overBalance||!validOffset){
        balanceWarning.textContent=overBalance ? `After the bank deposit offset, ${money(stripeAmount)} must come from Stripe, but only ${money(stripeAvailable)} is available.` : 'Reduce the bank offset to the amount available in Pack checking for Scout credits.';
      }
    }

    f.onsubmit=async e=>{
      e.preventDefault();clearNotice(fn);
      const purpose=String(new FormData(f).get('purpose')||'').trim();
      const lines=[...list.querySelectorAll('.payout-scout-row')].filter(row=>row.querySelector('[data-select]').checked).map(row=>({scout_id:row.dataset.scoutId,amount:Number(row.querySelector('[data-amount]').value||0)})).filter(x=>x.amount>0);
      if(!purpose)return setNotice(fn,'Enter what this payout is being applied toward, such as Summer Camp 2027.','error');
      if(!lines.length)return setNotice(fn,'Select at least one scout and transfer amount.','error');
      const payoutTotal=lines.reduce((sum,x)=>sum+x.amount,0);
      const offset=Number(bankInput.value||0);
      if(!await confirmAction({ title:"Apply Scout Credits?", message:`Apply ${money(payoutTotal)} in Scout credits to ${purpose}: ${money(offset)} from funds already deposited in Pack checking and ${money(payoutTotal-offset)} from Stripe.`, confirmLabel:"Apply Credits" }))return;
      setFormBusy(f,true,'Creating Stripe payout…');
      try{
        const created=await FundraisingService.createPayout({purpose,lines,bankOffsetAmount:offset});
        closeDialog(d);
        const notifications=created.parent_notifications||[];
        const sent=notifications.filter(x=>x.status==='sent').length;
        const missing=notifications.filter(x=>x.status==='no_email').length;
        const failed=notifications.filter(x=>x.status==='failed').length;
        let message=`${created.payout.payout_number} applied ${money(created.payout.total_amount)} in Scout credit: ${money(created.payout.bank_offset_amount||0)} already in Pack checking and ${money(created.payout.stripe_amount||0)} from Stripe.`;
        if(created.payout.stripe_amount>0 && created.payout.stripe_arrival_date){
          const arrival=new Date(`${created.payout.stripe_arrival_date}T12:00:00`).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
          message+=` Stripe expects it to reach the Pack bank account by ${arrival}.`;
        }
        if(sent)message+=` ${sent} parent notification${sent===1?'':'s'} sent.`;
        if(missing)message+=` ${missing} scout${missing===1?' has':'s have'} no parent email yet.`;
        if(failed)message+=` ${failed} email notification${failed===1?'':'s'} failed.`;
        setNotice(notice,message,failed?'error':'success');
        await load();
      }catch(error){setNotice(fn,error.message,'error')}
      finally{setFormBusy(f,false)}
    };
    bankInput.addEventListener('input',updatePayoutTotal);
  }

  function setupAdjustmentDialog(){
    const d=document.querySelector('#transaction-dialog'),f=document.querySelector('#transaction-form'),fn=document.querySelector('#transaction-form-notice');
    document.querySelector('#new-transaction').onclick=()=>{f.reset();f.elements.transaction_date.value=new Date().toISOString().slice(0,10);f.elements.scout_id.innerHTML='<option value="">Select scout</option>'+scouts.filter(x=>x.is_active).map(x=>`<option value="${x.id}">${escapeHtml(name(x))}</option>`).join('');clearNotice(fn);openDialog(d)};
    d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>closeDialog(d));
    f.onsubmit=async e=>{e.preventDefault();setFormBusy(f,true);const fd=new FormData(f),payload={scout_id:fd.get('scout_id'),transaction_type:fd.get('transaction_type'),amount:Number(fd.get('amount')),transaction_date:fd.get('transaction_date'),purpose:normalizeNullable(fd.get('purpose')),reference_number:normalizeNullable(fd.get('reference_number')),notes:normalizeNullable(fd.get('notes')),created_by:user.id,updated_by:user.id};try{await FundraisingService.createTransaction(payload)}catch(error){setFormBusy(f,false);return setNotice(fn,error.message,'error')}setFormBusy(f,false);closeDialog(d);setNotice(notice,'Adjustment recorded.','success');await load()};
  }
}

function name(s){return s?.is_general_fund?'General Fund':[s?.first_name,s?.last_name].filter(Boolean).join(' ')||'Unknown'}
function label(v){return({transfer_to_pack:'Paid to Pack',opening_balance:'Opening Balance',adjustment_credit:'Credit Adjustment',adjustment_debit:'Debit Adjustment'})[v]||v}
function statusBadge(v){const labels={draft:'Preparing',submitted:'Payout Pending',paid:'Paid',failed:'Failed',canceled:'Canceled'};const cls=v==='paid'?'status-badge--active':v==='failed'||v==='canceled'?'status-badge--inactive':'status-badge--info';return `<span class="status-badge ${cls}">${escapeHtml(labels[v]||v)}</span>`}
function payoutDialog(){return `<dialog class="portal-dialog portal-dialog--wide" id="payout-dialog"><form class="dialog-card payout-dialog-card" id="payout-form"><div class="dialog-header"><div><h2>Create Pack Payout</h2><p>Choose each scout and how much of the available credit to apply now.</p></div><button class="icon-button" data-close type="button">×</button></div><div class="stripe-payout-info" aria-live="polite"><div><span>Stripe available for payout</span><strong id="stripe-available-balance">Loading…</strong></div><div><span>Deposits available for offset</span><strong id="bank-deposit-available">Loading…</strong></div><div><span>Estimated bank arrival</span><strong id="stripe-estimated-arrival">Loading…</strong></div><p id="stripe-balance-status">Checking live Stripe balance…</p></div><div id="stripe-balance-warning" class="notice" hidden></div><label class="form-field form-field--full"><span>What is this payout for?</span><input name="purpose" placeholder="Summer Camp 2027, Pack dues, etc." required></label><div class="payout-scout-list" id="payout-scout-list"></div><div class="payout-total-bar"><span>Scout credits applied</span><strong id="payout-total">$0.00</strong></div><label class="form-field"><span>Already deposited in Pack checking</span><input name="bank_offset_amount" type="number" min="0" step="0.01" value="0.00" required></label><div class="payout-total-bar"><span>Stripe payout to Pack checking</span><strong id="stripe-payout-amount">$0.00</strong></div><p class="cell-note">Only selected Scout credits will be applied. Unselected credit remains available for later.</p><div id="payout-form-notice" class="notice" hidden></div><div class="dialog-actions"><button class="portal-button portal-button--secondary" data-close type="button">Cancel</button><button class="portal-button" type="submit">Apply Credits & Send Payout</button></div></form></dialog>`}
function adjustmentDialog(){return `<dialog class="portal-dialog" id="transaction-dialog"><form class="dialog-card" id="transaction-form"><div class="dialog-header"><h2>Record Adjustment</h2><button class="icon-button" data-close type="button">×</button></div><div class="form-grid"><label class="form-field form-field--full"><span>Scout or General Fund</span><select name="scout_id" required></select></label><label class="form-field"><span>Transaction type</span><select name="transaction_type" required><option value="opening_balance">Opening Balance</option><option value="adjustment_credit">Credit Adjustment</option><option value="adjustment_debit">Debit Adjustment</option></select></label><label class="form-field"><span>Amount</span><input name="amount" type="number" min="0.01" step="0.01" required></label><label class="form-field"><span>Date</span><input name="transaction_date" type="date" required></label><label class="form-field"><span>Purpose</span><input name="purpose" placeholder="Correction or opening balance"></label><label class="form-field"><span>Reference number</span><input name="reference_number"></label><label class="form-field form-field--full"><span>Notes</span><textarea name="notes" rows="3"></textarea></label></div><div id="transaction-form-notice" class="notice" hidden></div><div class="dialog-actions"><button class="portal-button portal-button--secondary" data-close type="button">Cancel</button><button class="portal-button" type="submit">Record Adjustment</button></div></form></dialog>`}
