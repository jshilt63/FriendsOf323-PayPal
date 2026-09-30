const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "purchase-orders";

exports.handler = async function handler(event) {
  const headers = { "Cache-Control": "no-store" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ error: "Method not allowed." }) };
  try {
    const token = getBearerToken(event.headers.authorization || event.headers.Authorization);
    const caller = await verifyUser(token);
    const profile = await getProfile(caller.id);
    if (!profile?.is_active) throw new Error("Portal access is required.");
    const body = JSON.parse(event.body || "{}");
    const id = String(body.purchase_order_id || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("A valid purchase-order ID is required.");
    const po = await getOne(`/rest/v1/purchase_orders?id=eq.${encodeURIComponent(id)}&select=id,po_number,pdf_storage_path`);
    if (!po?.pdf_storage_path) return { statusCode: 404, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ error: "No submitted PDF is archived for this purchase order." }) };
    const encoded = po.pdf_storage_path.split("/").map(encodeURIComponent).join("/");
    const result = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encoded}`, { headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` } });
    if (!result.ok) throw new Error("The archived purchase-order PDF could not be retrieved.");
    const pdf = Buffer.from(await result.arrayBuffer());
    return { statusCode: 200, isBase64Encoded: true, headers: { ...headers, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${String(po.po_number).replace(/[^a-z0-9._-]+/gi,"-")}.pdf"` }, body: pdf.toString("base64") };
  } catch (error) {
    return { statusCode: 500, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ error: error.message || "PDF retrieval failed." }) };
  }
};
function getBearerToken(header){const m=String(header||"").match(/^Bearer\s+(.+)$/i);if(!m)throw new Error("Authentication token is missing.");return m[1];}
async function verifyUser(token){const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${token}`}});const b=await r.json().catch(()=>({}));if(!r.ok||!b.id)throw new Error("Your session is invalid or expired.");return b;}
async function getProfile(id){return await getOne(`/rest/v1/user_profiles?id=eq.${encodeURIComponent(id)}&select=id,is_active`);}
async function getOne(path){const r=await fetch(`${SUPABASE_URL}${path}`,{headers:{apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${SUPABASE_SECRET_KEY}`}});const b=await r.json().catch(()=>[]);if(!r.ok)throw new Error(b.message||"Database lookup failed.");return b[0]||null;}
