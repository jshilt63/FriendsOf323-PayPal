const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

exports.handler = async event => {
  const headers = {"Content-Type":"application/json","Cache-Control":"no-store"};
  if (event.httpMethod !== "POST") return response(405,{error:"Method not allowed."},headers);
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !STRIPE_SECRET_KEY) return response(500,{error:"Payout configuration is incomplete."},headers);
  let draft = null, stripePayout = null;
  try {
    const token = String(event.headers.authorization || event.headers.Authorization || "").match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return response(401,{error:"Sign in again."},headers);
    const authResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${token}`}});
    const caller = await parse(authResponse);
    if (!authResponse.ok || !caller.id) return response(401,{error:"Session expired."},headers);
    const profiles = await rest(`/rest/v1/user_profiles?id=eq.${encodeURIComponent(caller.id)}&select=role,is_active`);
    if (!profiles[0]?.is_active || profiles[0].role !== "coffee_bean") return response(403,{error:"Coffee Bean access is required."},headers);
    const poId = String(JSON.parse(event.body || "{}").purchase_order_id || "");
    if (!/^[0-9a-f-]{36}$/i.test(poId)) return response(400,{error:"Valid purchase order ID required."},headers);

    draft = await rpc("create_roaster_funding_draft",{p_po_id:poId,p_created_by:caller.id});
    const cents = Math.round(Number(draft.amount)*100);
    if (!Number.isSafeInteger(cents) || cents<=0) throw new Error("Invalid roaster funding amount.");
    const params = new URLSearchParams({amount:String(cents),currency:"usd",description:`Friends of 323 roaster funding ${draft.po_number}`});
    params.set("metadata[roaster_funding_id]",draft.id);
    params.set("metadata[purchase_order_id]",poId);
    const stripeResponse = await fetch("https://api.stripe.com/v1/payouts",{
      method:"POST",headers:{Authorization:`Bearer ${STRIPE_SECRET_KEY}`,"Content-Type":"application/x-www-form-urlencoded","Idempotency-Key":`friends323-roaster-funding-${draft.id}`},body:params.toString()
    });
    stripePayout = await parse(stripeResponse);
    if (!stripeResponse.ok) throw new Error(stripePayout.error?.message || "Stripe payout failed.");
    const arrival = stripePayout.arrival_date ? new Date(stripePayout.arrival_date*1000).toISOString().slice(0,10) : null;
    await rpc("mark_roaster_funding_submitted",{p_id:draft.id,p_stripe_id:stripePayout.id,p_arrival:arrival});
    return response(200,{success:true,po_number:draft.po_number,amount:draft.amount,stripe_payout_id:stripePayout.id,arrival_date:arrival},headers);
  } catch(error) {
    console.error("create-roaster-funding-payout",error);
    if (draft && !stripePayout?.id) {
      try { await rpc("fail_roaster_funding_draft",{p_id:draft.id,p_message:error.message}); } catch(e) { console.error("roaster funding draft cleanup",e); }
    }
    const message = stripePayout?.id ? `Stripe created payout ${stripePayout.id}, but the portal could not record it. Do not retry; reconcile in Stripe.` : error.message;
    return response(500,{error:message || "Roaster funding payout failed."},headers);
  }
};

async function rest(path) {
  const response=await fetch(`${SUPABASE_URL}${path}`,{headers:adminHeaders()});
  const body=await parse(response);
  if(!response.ok)throw new Error(body.message||"Database lookup failed.");
  return body;
}
async function rpc(name,body) {
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:"POST",headers:adminHeaders(),body:JSON.stringify(body)});
  const result=await parse(response);
  if(!response.ok)throw new Error(result.message||result.error||`${name} failed.`);
  return result;
}
function adminHeaders(){return {"Content-Type":"application/json",apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${SUPABASE_SECRET_KEY}`};}
async function parse(response){return response.json().catch(()=>({}));}
function response(statusCode,body,headers){return {statusCode,headers,body:JSON.stringify(body)};}
