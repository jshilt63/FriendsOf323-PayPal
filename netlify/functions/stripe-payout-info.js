const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

exports.handler = async function handler(event) {
  const headers = {"Content-Type":"application/json","Cache-Control":"no-store"};
  if (event.httpMethod !== "GET") return response(405,{error:"Method not allowed."},headers);
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !STRIPE_SECRET_KEY) {
    return response(500,{error:"Stripe payout configuration is incomplete."},headers);
  }

  try {
    const token = getBearerToken(event.headers.authorization || event.headers.Authorization);
    const caller = await verifyUser(token);
    const profile = await getProfile(caller.id);
    if (!profile?.is_active || profile.role !== "coffee_bean") {
      return response(403,{error:"Coffee Bean access is required."},headers);
    }

    const stripeBalance = await stripeGet("/v1/balance");
    const available = sumCurrency(stripeBalance.available,"usd");
    const pending = sumCurrency(stripeBalance.pending,"usd");

    return response(200,{
      available_usd:available / 100,
      pending_usd:pending / 100,
      estimated_arrival_date:addBusinessDays(new Date(),2),
      estimate_note:"Estimated standard arrival. Stripe confirms the exact arrival date after the payout is created."
    },headers);
  } catch (error) {
    console.error("stripe-payout-info error",error);
    return response(500,{error:error.message || "Stripe payout balance could not be loaded."},headers);
  }
};

function sumCurrency(rows,currency){
  return (Array.isArray(rows)?rows:[])
    .filter(row=>String(row.currency||"").toLowerCase()===currency)
    .reduce((sum,row)=>sum+Number(row.amount||0),0);
}

function addBusinessDays(start,count){
  const date=new Date(start);
  let added=0;
  while(added<count){
    date.setUTCDate(date.getUTCDate()+1);
    const day=date.getUTCDay();
    if(day!==0 && day!==6) added++;
  }
  return date.toISOString().slice(0,10);
}

function getBearerToken(header){
  const match=String(header||"").match(/^Bearer\s+(.+)$/i);
  if(!match) throw new Error("Authentication token is missing.");
  return match[1];
}

async function verifyUser(token){
  const result=await fetch(`${SUPABASE_URL}/auth/v1/user`,{
    headers:{apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${token}`}
  });
  const body=await parseJson(result);
  if(!result.ok||!body.id) throw new Error("Your session is invalid or expired.");
  return body;
}

async function getProfile(userId){
  const result=await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${encodeURIComponent(userId)}&select=id,role,is_active`,
    {headers:adminHeaders()}
  );
  const body=await parseJson(result);
  if(!result.ok) throw new Error(body.message||"User profile could not be loaded.");
  return body[0]||null;
}

async function stripeGet(path){
  const result=await fetch(`https://api.stripe.com${path}`,{
    headers:{Authorization:`Bearer ${STRIPE_SECRET_KEY}`}
  });
  const body=await parseJson(result);
  if(!result.ok) throw new Error(body?.error?.message||"Stripe balance lookup failed.");
  return body;
}

function adminHeaders(){
  return {"Content-Type":"application/json",apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${SUPABASE_SECRET_KEY}`};
}
async function parseJson(result){return result.json().catch(()=>({}));}
function response(statusCode,body,headers){return {statusCode,headers,body:JSON.stringify(body)};}
