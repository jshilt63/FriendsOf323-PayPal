const HEADERS = { "Content-Type":"application/json", "Cache-Control":"no-store" };
const respond = (status, body) => new Response(JSON.stringify(body), { status, headers:HEADERS });

export default async () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceRoleKey) return respond(500, { error:"Store announcement is unavailable." });

  const headers = { apikey:serviceRoleKey, Authorization:`Bearer ${serviceRoleKey}`, Accept:"application/json" };
  const result = await fetch(
    `${supabaseUrl}/rest/v1/storefront_settings?select=announcement_enabled,announcement_title,announcement_message,updated_at&id=eq.1&limit=1`,
    { headers }
  );
  if (!result.ok) return respond(500, { error:"Store announcement could not be loaded." });

  const row = (await result.json())?.[0] || {};
  return respond(200, {
    enabled:Boolean(row.announcement_enabled),
    title:String(row.announcement_title || ""),
    message:String(row.announcement_message || ""),
    updated_at:row.updated_at || null
  });
};
