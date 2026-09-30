import { ScoutsService } from "../services/scouts-service.js";
import { requirePortalUser } from "../../assets/auth-common.js";
import { renderPortalLayout, escapeHtml } from "../components/layout.js?v=1.9.0";
import { DataGrid } from "../components/data-grid.js";
import { hasMinimumRole } from "../shared/roles.js";
import { clearNotice, closeDialog, normalizeNullable, openDialog, setFormBusy, setNotice, text } from "./shared.js";

const result = await requirePortalUser();
if (result) initialize(result);

async function initialize({ user, profile }) {
  const canManage = hasMinimumRole(profile.role, "coffee_bean");
  const content = renderPortalLayout({ profile, user, pageTitle: "Scouts" });
  content.innerHTML = `
    <div class="breadcrumb">Committee Portal / Scouts</div>
    <div class="page-heading"><div><h1>Scout Roster</h1><p>Manage scouts, den assignments, and parent/guardian contacts.</p></div>
      ${canManage ? '<button class="portal-button" id="add-scout">Add Scout</button>' : ''}</div>
    <div id="page-notice" class="notice" hidden></div>
    <section class="panel"><div id="scouts-grid"></div></section>
    ${canManage ? dialogHtml() : ''}`;

  const notice = document.querySelector('#page-notice');
  let rows = [];
  let dens = [];
  let editScout = null;
  const grid = new DataGrid({
    container:'#scouts-grid',
    columns:[
      {key:'name',label:'Scout',render:r=>`<strong>${escapeHtml(r.name)}</strong>${r.notes?`<div class="cell-note">${escapeHtml(r.notes)}</div>`:''}`},
      {key:'den_display',label:'Den',render:r=>escapeHtml(r.den_display)},
      {key:'parent_name',label:'Parent / Guardian',render:r=>r.is_general_fund?'—':escapeHtml(r.parent_name||'Not entered')},
      {key:'parent_email',label:'Parent Email',render:r=>r.is_general_fund?'—':escapeHtml(r.parent_email||'Not entered')},
      {key:'is_general_fund',label:'Type',render:r=>r.is_general_fund?'<span class="status-badge status-badge--info">General Fund</span>':'Scout',exportValue:r=>r.is_general_fund?'General Fund':'Scout'},
      {key:'is_active',label:'Status',render:r=>`<span class="status-badge ${r.is_active?'status-badge--active':'status-badge--inactive'}">${r.is_active?'Active':'Inactive'}</span>`,exportValue:r=>r.is_active?'Active':'Inactive'}
    ],
    searchFields:['name','den_display','parent_name','parent_email','notes'],
    exportFileName:'friends-323-scouts.csv',
    filters:[{key:'den',label:'Den',type:'select',defaultValue:'all',options:denFilterOptions(profile),predicate:(r,v)=>v==='all'||r.den_id===v},{key:'inactive',label:'Show inactive',type:'checkbox',defaultValue:false,predicate:(r,v)=>v||r.is_active}],
    rowActions:canManage?r=>`<button class="table-action" data-edit="${r.id}">Edit</button>`:null
  });
  grid.container.addEventListener('datagrid:render',bind);

  async function load(){
    try {
      const [data, denRows] = await Promise.all([ScoutsService.list(), ScoutsService.listDens()]);
      dens = denRows || [];
      rows=(data||[]).map(r=>{
        const parent=primaryGuardian(r);
        return {...r,name:[r.first_name,r.last_name].filter(Boolean).join(' '),den_display:denDisplay(r.dens),parent_name:parent?[parent.first_name,parent.last_name].filter(Boolean).join(' '):'',parent_email:parent?.email||'',parent_relationship:parent?.relationship||'Parent/Guardian'};
      });
      grid.setRows(rows);
      populateDenSelect();
      populateRosterDenFilter(grid, dens, profile);
    } catch(error){ setNotice(notice,error.message,'error'); }
  }
  function bind(){
    grid.container.querySelectorAll('[data-edit]').forEach(button => {
      button.onclick = () => editScout?.(button.dataset.edit);
    });
  }
  function populateDenSelect(){
    const select=document.querySelector('#scout-form [name="den_id"]');
    if(!select)return;
    select.innerHTML='<option value="">No den assigned</option>'+dens.map(d=>`<option value="${d.id}">${escapeHtml(denDisplay(d))}</option>`).join('');
  }
  function toggleParentFields(form,isGeneral){
    form.querySelector('[data-parent-section]').hidden=isGeneral;
  }

  if(canManage){
    const d=document.querySelector('#scout-dialog'),f=document.querySelector('#scout-form'),fn=document.querySelector('#scout-form-notice');
    document.querySelector('#add-scout').onclick=()=>{f.reset();f.elements.id.value='';f.elements.is_active.checked=true;f.elements.den_id.value='';f.elements.den_id.disabled=false;f.elements.is_general_fund.disabled=false;toggleParentFields(f,false);clearNotice(fn);openDialog(d)};
    d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>closeDialog(d));
    f.elements.is_general_fund.addEventListener('change',()=>toggleParentFields(f,f.elements.is_general_fund.checked));
    editScout = function(id){
      const r=rows.find(x=>x.id===id);
      for(const k of ['id','first_name','last_name','unit','notes'])f.elements[k].value=r[k]||'';
      f.elements.den_id.value=r.den_id||'';
      f.elements.den_id.disabled=Boolean(r.is_general_fund);
      f.elements.is_active.checked=r.is_active;
      f.elements.is_general_fund.checked=r.is_general_fund;
      f.elements.is_general_fund.disabled=r.is_general_fund;
      f.elements.parent_first_name.value=primaryGuardian(r)?.first_name||'';
      f.elements.parent_last_name.value=primaryGuardian(r)?.last_name||'';
      f.elements.parent_email.value=primaryGuardian(r)?.email||'';
      f.elements.parent_relationship.value=r.parent_relationship||'Parent/Guardian';
      toggleParentFields(f,r.is_general_fund);
      clearNotice(fn);openDialog(d);
    }
    f.onsubmit=async e=>{
      e.preventDefault();setFormBusy(f,true);
      const fd=new FormData(f),id=fd.get('id'),old=rows.find(x=>x.id===id);
      const isGeneral=old?.is_general_fund||fd.get('is_general_fund')==='on';
      const payload={
        first_name:String(fd.get('first_name')||'').trim(),
        last_name:normalizeNullable(fd.get('last_name')),
        unit:normalizeNullable(fd.get('unit')),
        notes:normalizeNullable(fd.get('notes')),
        den_id:isGeneral?null:normalizeNullable(fd.get('den_id')),
        is_active:fd.get('is_active')==='on',
        is_general_fund:isGeneral,updated_by:user.id
      };
      if(!id)payload.created_by=user.id;
      try{
        const saved=await ScoutsService.save(id,payload);
        if(!isGeneral){
          await ScoutsService.setPrimaryGuardian(saved.id,{
            first_name:String(fd.get('parent_first_name')||'').trim(),
            last_name:String(fd.get('parent_last_name')||'').trim(),
            email:String(fd.get('parent_email')||'').trim().toLowerCase(),
            relationship:String(fd.get('parent_relationship')||'Parent/Guardian').trim()
          });
        }
      }catch(error){setFormBusy(f,false);return setNotice(fn,error.message,'error')}
      setFormBusy(f,false);closeDialog(d);setNotice(notice,id?'Scout updated.':'Scout added.','success');await load();
    };
  }
  await load();
  if(new URLSearchParams(window.location.search).get('action')==='new'&&canManage)document.querySelector('#add-scout')?.click();
}

function primaryGuardian(scout){
  const link=(scout?.scout_guardians||[]).find(x=>x.is_primary) || (scout?.scout_guardians||[])[0];
  if(!link?.guardians)return null;
  return {...link.guardians,relationship:link.relationship};
}
function denDisplay(den){return den?.den_number?`Den ${den.den_number} · ${den.current_rank_working_toward}`:'No den assigned';}
function dialogHtml(){return `<dialog class="portal-dialog" id="scout-dialog"><form method="post" class="dialog-card" id="scout-form"><div class="dialog-header"><h2>Scout</h2><button type="button" class="icon-button" data-close>×</button></div><input type="hidden" name="id"><div class="form-grid"><label class="form-field"><span>First name or fund name</span><input name="first_name" required></label><label class="form-field"><span>Last name</span><input name="last_name"></label><label class="form-field form-field--full"><span>Den</span><select name="den_id"><option value="">No den assigned</option></select></label><label class="form-field form-field--full"><span>Unit</span><input name="unit"></label><label class="form-field form-field--full"><span>Notes</span><textarea name="notes"></textarea></label><label class="checkbox-field"><input name="is_active" type="checkbox" checked> Active</label><label class="checkbox-field"><input name="is_general_fund" type="checkbox"> General Fund</label></div><fieldset class="guardian-fieldset" data-parent-section><legend>Primary Parent / Guardian</legend><p class="cell-note">Optional for now. Add the email when you have it from ScoutNet so transfer notifications can be sent automatically.</p><div class="form-grid"><label class="form-field"><span>First name</span><input name="parent_first_name"></label><label class="form-field"><span>Last name</span><input name="parent_last_name"></label><label class="form-field form-field--full"><span>Email</span><input name="parent_email" type="email"></label><label class="form-field form-field--full"><span>Relationship</span><input name="parent_relationship" value="Parent/Guardian"></label></div></fieldset><div id="scout-form-notice" class="notice" hidden></div><div class="dialog-actions"><button type="button" class="portal-button portal-button--secondary" data-close>Cancel</button><button type="submit" class="portal-button">Save Scout</button></div></form></dialog>`;}

function denFilterOptions(profile){
  if(profile.role==='barista'&&profile.den_id)return[{value:'all',label:'All Scouts'},{value:profile.den_id,label:'My Den'}];
  return[{value:'all',label:'All Dens'}];
}
function populateRosterDenFilter(grid,dens,profile){
  const select=grid.container.querySelector('[data-filter="den"]');
  if(!select||profile.role==='barista')return;
  select.innerHTML='<option value="all">All Dens</option>'+dens.map(d=>`<option value="${d.id}">${escapeHtml(denDisplay(d))}</option>`).join('');
}
