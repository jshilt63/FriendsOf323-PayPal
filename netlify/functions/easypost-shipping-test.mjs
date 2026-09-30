import {
  easypostEnabled,
  easypostEnvironment,
  getEasyPostGroundAdvantageRate,
  packageIsRateReady,
  packageParcel,
  storefrontOriginAddress
} from "./easypost-shipping-lib.mjs";

const HEADERS = { "Content-Type":"application/json", "Cache-Control":"no-store" };
const respond = (status, body) => new Response(JSON.stringify(body), { status, headers:HEADERS });

async function loadJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(await response.text() || "Database lookup failed.");
  return response.json();
}

export default async request => {
  if (request.method !== "POST") return respond(405, { error:"POST required." });
  if (!easypostEnabled()) return respond(503, { error:"EasyPost rating is disabled in Netlify.", environment:easypostEnvironment() });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceRoleKey) return respond(500, { error:"Shipping configuration is unavailable." });

  const input = await request.json().catch(() => ({}));
  const packageId = String(input.package_id || "").trim();
  const destinationZip = String(input.destination_zip || "").trim();
  const contentsWeight = Number(input.contents_weight_ounces || 0);
  if (!packageId) return respond(400, { error:"Choose a shipping package." });
  if (!/^\d{5}(?:-\d{4})?$/.test(destinationZip)) return respond(400, { error:"Enter a valid destination ZIP code." });
  if (!Number.isFinite(contentsWeight) || contentsWeight < 0) return respond(400, { error:"Contents weight must be zero or greater." });

  const headers = { apikey:serviceRoleKey, Authorization:`Bearer ${serviceRoleKey}`, Accept:"application/json" };
  try {
    const [settingsRows, packages] = await Promise.all([
      loadJson(`${supabaseUrl}/rest/v1/storefront_settings?select=shipping_packaging_charge,shipping_return_name,shipping_return_address_line_1,shipping_return_address_line_2,shipping_return_city,shipping_return_state,shipping_return_postal_code&id=eq.1&limit=1`, headers),
      loadJson(`${supabaseUrl}/rest/v1/shipping_rate_tiers?select=id,label,min_bags,max_bags,package_length_inches,package_width_inches,package_height_inches,package_weight_ounces,rate_amount,is_active&id=eq.${encodeURIComponent(packageId)}&limit=1`, headers)
    ]);
    const settings = settingsRows?.[0] || {};
    const pkg = packages?.[0];
    if (!pkg) return respond(404, { error:"Shipping package not found." });
    if (!packageIsRateReady(pkg)) return respond(400, { error:"Enter this package's dimensions and empty weight before testing EasyPost." });
    if (![settings.shipping_return_address_line_1,settings.shipping_return_city,settings.shipping_return_state,settings.shipping_return_postal_code].every(Boolean)) {
      return respond(400, { error:"Complete the Shipping Label Return Address before testing EasyPost." });
    }

    const parcel = packageParcel(pkg, contentsWeight);
    const quote = await getEasyPostGroundAdvantageRate({
      fromAddress: storefrontOriginAddress(settings),
      toAddress: { zip:destinationZip },
      parcel
    });
    const packagingCharge = Math.max(0, Number(settings.shipping_packaging_charge || 0));
    const postageAmount = Number(quote.amount.toFixed(2));
    return respond(200, {
      ok:true,
      package:{ id:pkg.id, label:pkg.label },
      parcel,
      packaging_charge:Number(packagingCharge.toFixed(2)),
      postage_amount:postageAmount,
      customer_amount:Number((postageAmount + packagingCharge).toFixed(2)),
      quote
    });
  } catch (error) {
    console.error("EasyPost shipping test failed:", error?.details || error);
    return respond(502, { error:error.message || "EasyPost shipping test failed.", code:error.code || null, environment:easypostEnvironment() });
  }
};
