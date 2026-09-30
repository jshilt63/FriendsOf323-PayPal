import {
  easypostEnabled,
  easypostEnvironment,
  getEasyPostGroundAdvantageRate,
  packageFitsBagCount,
  packageIsRateReady,
  packageParcel,
  parseBagWeightOunces,
  storefrontOriginAddress
} from "./easypost-shipping-lib.mjs";

const HEADERS = { "Content-Type":"application/json", "Cache-Control":"no-store" };
const respond = (status, body) => new Response(JSON.stringify(body), { status, headers:HEADERS });

async function loadShippingConfiguration(supabaseUrl, serviceRoleKey) {
  const headers = { apikey:serviceRoleKey, Authorization:`Bearer ${serviceRoleKey}`, Accept:"application/json" };
  const [settingsResponse, ratesResponse] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/storefront_settings?select=shipping_enabled,shipping_packaging_charge,shipping_return_name,shipping_return_address_line_1,shipping_return_address_line_2,shipping_return_city,shipping_return_state,shipping_return_postal_code&id=eq.1&limit=1`, { headers }),
    fetch(`${supabaseUrl}/rest/v1/shipping_rate_tiers?select=id,label,min_bags,max_bags,package_length_inches,package_width_inches,package_height_inches,package_weight_ounces,rate_amount,is_active&is_active=eq.true&order=min_bags.asc`, { headers })
  ]);
  if (!settingsResponse.ok) throw new Error("Shipping settings could not be loaded.");
  if (!ratesResponse.ok) throw new Error("Shipping packages could not be loaded.");
  const settingsRows = await settingsResponse.json();
  return { settings:settingsRows?.[0] || {}, rates:await ratesResponse.json(), headers };
}

function safePublicRate(rate) {
  return {
    id:rate.id,
    label:rate.label,
    min_bags:rate.min_bags,
    max_bags:rate.max_bags,
    rate_amount:rate.rate_amount,
    rate_ready:packageIsRateReady(rate)
  };
}

async function calculateContentsWeight({ items, supabaseUrl, headers }) {
  if (!Array.isArray(items) || !items.length) throw new Error("No coffee items were supplied for shipping.");
  const normalized = items.map(item => ({
    product_id:String(item?.product_id || "").trim(),
    quantity:Number(item?.quantity || 0)
  })).filter(item => item.product_id && Number.isInteger(item.quantity) && item.quantity > 0);
  if (!normalized.length || normalized.length !== items.length) throw new Error("Shipping items are invalid.");

  const ids = [...new Set(normalized.map(item => item.product_id))];
  const encodedIds = ids.map(id => `"${id.replaceAll('"','')}"`).join(",");
  const response = await fetch(`${supabaseUrl}/rest/v1/products?select=id,bag_size,is_active&id=in.(${encodeURIComponent(encodedIds)})`, { headers });
  if (!response.ok) throw new Error("Coffee product weights could not be loaded.");
  const products = await response.json();
  const map = new Map(products.map(product => [product.id, product]));

  let bags = 0;
  let ounces = 0;
  for (const item of normalized) {
    const product = map.get(item.product_id);
    if (!product || !product.is_active) throw new Error("One or more coffee products are unavailable.");
    const bagWeight = parseBagWeightOunces(product.bag_size);
    if (!(bagWeight > 0)) throw new Error(`The package weight cannot be calculated for bag size ${product.bag_size || "unknown"}.`);
    bags += item.quantity;
    ounces += bagWeight * item.quantity;
  }
  return { bagCount:bags, contentsWeightOunces:Number(ounces.toFixed(2)) };
}

export default async request => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceRoleKey) return respond(500, { error:"Shipping configuration is unavailable." });

  try {
    const { settings, rates, headers } = await loadShippingConfiguration(supabaseUrl, serviceRoleKey);
    const enabled = Boolean(settings.shipping_enabled);
    if (!enabled) return respond(200, { enabled:false, rates:[], easypost:{ enabled:easypostEnabled(), environment:easypostEnvironment() } });

    if (request.method === "GET") {
      return respond(200, {
        enabled:true,
        rates:rates.map(safePublicRate),
        easypost:{ enabled:easypostEnabled(), environment:easypostEnvironment() }
      });
    }

    if (request.method !== "POST") return respond(405, { error:"GET or POST required." });
    const input = await request.json().catch(() => ({}));
    const destination = input.destination || {};
    const postalCode = String(destination.postal_code || destination.zip || "").trim();
    if (!/^\d{5}(?:-\d{4})?$/.test(postalCode)) return respond(400, { error:"Enter a valid shipping ZIP code." });

    const weights = await calculateContentsWeight({ items:input.items, supabaseUrl, headers });
    const pkg = rates.find(rate => packageFitsBagCount(rate, weights.bagCount));
    if (!pkg) return respond(400, { error:`Shipping is not configured for ${weights.bagCount} bag${weights.bagCount === 1 ? "" : "s"}.` });

    if (!easypostEnabled()) {
      return respond(503, { error:"EasyPost shipping rating is disabled. Enable EasyPost before offering shipping at checkout." });
    }
    if (!packageIsRateReady(pkg)) {
      return respond(503, { error:`Shipping cannot be calculated for ${pkg.label || "this package"} because its dimensions or empty-box weight are incomplete.` });
    }

    try {
      const parcel = packageParcel(pkg, weights.contentsWeightOunces);
      const quote = await getEasyPostGroundAdvantageRate({
        fromAddress:storefrontOriginAddress(settings),
        toAddress:{
          name:destination.name,
          street1:destination.address_line_1 || destination.street1,
          street2:destination.address_line_2 || destination.street2,
          city:destination.city,
          state:destination.state,
          zip:postalCode
        },
        parcel
      });
      const packagingCharge = Math.max(0, Number(settings.shipping_packaging_charge || 0));
      const postageAmount = Number(quote.amount.toFixed(2));
      const customerAmount = Number((postageAmount + packagingCharge).toFixed(2));
      return respond(200, {
        enabled:true,
        amount:customerAmount,
        postage_amount:postageAmount,
        packaging_charge:Number(packagingCharge.toFixed(2)),
        source:"easypost",
        label:`USPS Ground Advantage + packaging — ${pkg.label}`,
        package:{ id:pkg.id, label:pkg.label },
        bag_count:weights.bagCount,
        contents_weight_ounces:weights.contentsWeightOunces,
        parcel,
        quote
      });
    } catch (error) {
      console.error("EasyPost storefront quote failed:", error?.details || error);
      return respond(503, {
        error:`USPS shipping could not be calculated through EasyPost. ${error.message || "Please try again shortly."}`
      });
    }
  } catch (error) {
    console.error("Shipping quote error:", error);
    return respond(500, { error:error.message || "Shipping is temporarily unavailable." });
  }
};
