import {notifyTransfer} from '../lib/transfer-notifications.mjs';
import {staff, db, response, uuid, cents, fail} from '../lib/paypal.mjs';
export default async request=>{
 if(request.method!=='POST')return response(405,{error:'Method not allowed.'});
 try{
  const user=await staff(request);const body=await request.json();
  if(!uuid(body.request_key)||!['paypal','bank'].includes(body.source)||!String(body.reference||'').trim()||!String(body.purpose||'').trim()||!/^\d{4}-\d{2}-\d{2}$/.test(body.transfer_date||''))fail('Complete the transfer details.');
  if(!Array.isArray(body.lines)||!body.lines.length||body.lines.some(l=>!uuid(l.scout_id)||cents(l.amount)<=0))fail('Choose valid Scout credits.');
  const transfer=await db('/rest/v1/rpc/record_paypal_pack_transfer',{method:'POST',body:{p_request_key:body.request_key,p_created_by:user.id,p_source:body.source,p_reference:body.reference,p_purpose:body.purpose,p_date:body.transfer_date,p_lines:body.lines}});
  let parent_notifications=[];try {parent_notifications=await notifyTransfer(transfer);}catch(error){parent_notifications=[{status:"failed"}];}
  return response(200,{success:true,transfer,parent_notifications});
 }catch(error){return response(error.status||500,{error:error.message});}
};
