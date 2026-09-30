const USPS_BASE_URL = "https://apis.usps.com";
let cachedToken = null;
let cachedTokenExpiresAt = 0;

function respond(statusCode, body) {
  return { statusCode, headers:{ "Content-Type":"application/json", "Cache-Control":"no-store" }, body:JSON.stringify(body) };
}

async function getUspsToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) return cachedToken;
  const clientId = process.env.USPS_CONSUMER_KEY;
  const clientSecret = process.env.USPS_CONSUMER_SECRET;
  if (!clientId || !clientSecret) throw new Error("USPS credentials are not configured yet.");

  const response = await fetch(`${USPS_BASE_URL}/oauth2/v3/token`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ client_id:clientId, client_secret:clientSecret, grant_type:"client_credentials" })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(body.error_description || body.error || "USPS authentication failed.");
  cachedToken = body.access_token;
  cachedTokenExpiresAt = Date.now() + Number(body.expires_in || 3600) * 1000;
  return cachedToken;
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return respond(405, { error:"Method not allowed." });
  if (!process.env.USPS_CONSUMER_KEY || !process.env.USPS_CONSUMER_SECRET) {
    return respond(503, { error:"USPS rating is not configured yet.", code:"USPS_NOT_CONFIGURED" });
  }

  // The endpoint is intentionally staged but not exposed to checkout yet.  Once USPS
  // credentials are issued and package measurements are entered, we will validate the
  // live Domestic Prices v3 request/response and enable rating from checkout.
  try {
    await getUspsToken();
    return respond(200, { ready:true, message:"USPS authentication succeeded. Live package rating will be enabled after package measurements are configured." });
  } catch (error) {
    console.error("USPS setup check failed:", error);
    return respond(502, { error:error.message || "USPS setup check failed." });
  }
}
