const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async function handler(event) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed." }, headers);
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return reply(500, { error: "Supabase environment variables are not configured." }, headers);

  try {
    const token = bearer(event.headers.authorization || event.headers.Authorization);
    const user = await verifyUser(token);
    const profile = await getProfile(user.id);
    if (!profile?.is_active || profile.role !== "coffee_bean") {
      return reply(403, { error: "Coffee Bean access is required." }, headers);
    }

    const body = JSON.parse(event.body || "{}");
    const address = String(body.address || "").trim();
    if (!address) return reply(400, { error: "Address is required." }, headers);
    if (address.length > 200) return reply(400, { error: "Address is too long." }, headers);

    const url = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
    url.searchParams.set("address", address);
    url.searchParams.set("benchmark", "Public_AR_Current");
    url.searchParams.set("format", "json");

    const response = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": "FriendsOf323/1.0" }
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Census geocoder returned ${response.status}.`);

    const match = json?.result?.addressMatches?.[0];
    const latitude = Number(match?.coordinates?.y);
    const longitude = Number(match?.coordinates?.x);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return reply(404, { error: "No Census geocoder match was found for that address." }, headers);
    }

    return reply(200, {
      latitude,
      longitude,
      matched_address: match.matchedAddress || address,
      source: "US Census Geocoder"
    }, headers);
  } catch (error) {
    console.error("geocode-address error", error);
    return reply(500, { error: error.message || "Address geocoding failed." }, headers);
  }
};

function bearer(header) {
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Authentication token is missing.");
  return match[1];
}

async function verifyUser(token) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${token}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.id) throw new Error("Your session is invalid or expired.");
  return body;
}

async function getProfile(userId) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${encodeURIComponent(userId)}&select=id,role,is_active`,
    { headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` } }
  );
  const body = await response.json().catch(() => []);
  if (!response.ok) throw new Error(body.message || "Unable to verify portal access.");
  return body[0] || null;
}

function reply(statusCode, body, headers) {
  return { statusCode, headers, body: JSON.stringify(body) };
}
