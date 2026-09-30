const EASYPOST_API_URL = "https://api.easypost.com/v2/shipments";

export function easypostEnvironment() {
  return String(process.env.EASYPOST_API_ENVIRONMENT || "test").trim().toLowerCase() === "production"
    ? "production"
    : "test";
}

export function easypostEnabled() {
  return String(process.env.EASYPOST_RATING_ENABLED || "").trim().toLowerCase() === "true";
}

export function easypostApiKey() {
  const environment = easypostEnvironment();
  return environment === "production"
    ? process.env.EASYPOST_PRODUCTION_API_KEY
    : process.env.EASYPOST_TEST_API_KEY;
}

export function parseBagWeightOunces(bagSize) {
  const text = String(bagSize || "").trim().toLowerCase();
  const ounces = text.match(/([0-9]+(?:\.[0-9]+)?)\s*oz/);
  if (ounces) return Number(ounces[1]);
  const pounds = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:lb|lbs|pound|pounds)/);
  if (pounds) return Number(pounds[1]) * 16;
  return null;
}

export function packageFitsBagCount(pkg, bagCount) {
  return Number(bagCount) >= Number(pkg.min_bags) &&
    (pkg.max_bags == null || Number(bagCount) <= Number(pkg.max_bags));
}

export function packageIsRateReady(pkg) {
  return [
    pkg?.package_length_inches,
    pkg?.package_width_inches,
    pkg?.package_height_inches,
    pkg?.package_weight_ounces
  ].every(value => Number(value) > 0);
}

function cleanAddress(address = {}) {
  return {
    name: String(address.name || "").trim() || undefined,
    company: String(address.company || "").trim() || undefined,
    street1: String(address.street1 || "").trim() || undefined,
    street2: String(address.street2 || "").trim() || undefined,
    city: String(address.city || "").trim() || undefined,
    state: String(address.state || "").trim().toUpperCase() || undefined,
    zip: String(address.zip || "").trim() || undefined,
    country: "US",
    phone: String(address.phone || "").trim() || undefined,
    email: String(address.email || "").trim() || undefined
  };
}

export async function getEasyPostGroundAdvantageRate({ fromAddress, toAddress, parcel }) {
  if (!easypostEnabled()) {
    const error = new Error("EasyPost rating is disabled.");
    error.code = "EASYPOST_DISABLED";
    throw error;
  }

  const apiKey = easypostApiKey();
  if (!apiKey) {
    const error = new Error(`EasyPost ${easypostEnvironment()} API key is not configured.`);
    error.code = "EASYPOST_NOT_CONFIGURED";
    throw error;
  }

  const payload = {
    shipment: {
      from_address: cleanAddress(fromAddress),
      to_address: cleanAddress(toAddress),
      parcel: {
        length: Number(parcel.length),
        width: Number(parcel.width),
        height: Number(parcel.height),
        weight: Number(parcel.weight)
      }
    }
  };

  const response = await fetch(EASYPOST_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || body?.error?.errors?.[0]?.message || body?.message || "EasyPost rate request failed.";
    const error = new Error(message);
    error.code = "EASYPOST_REQUEST_FAILED";
    error.details = body;
    throw error;
  }

  const rates = Array.isArray(body.rates) ? body.rates : [];
  const ground = rates.find(rate =>
    String(rate.carrier || "").toUpperCase() === "USPS" &&
    String(rate.service || "").toLowerCase() === "groundadvantage"
  );

  if (!ground) {
    const error = new Error("USPS Ground Advantage was not returned for this package and destination.");
    error.code = "GROUND_ADVANTAGE_UNAVAILABLE";
    error.details = body.messages || [];
    throw error;
  }

  const retail = Number(ground.retail_rate);
  const list = Number(ground.list_rate);
  const account = Number(ground.rate);
  const customerAmount = Number.isFinite(account) && account > 0
    ? account
    : Number.isFinite(list) && list > 0
      ? list
      : retail;

  if (!Number.isFinite(customerAmount) || customerAmount < 0) {
    const error = new Error("EasyPost returned USPS Ground Advantage without a usable price.");
    error.code = "INVALID_EASYPOST_RATE";
    throw error;
  }

  return {
    source: "easypost",
    environment: easypostEnvironment(),
    carrier: ground.carrier,
    service: ground.service,
    amount: Number(customerAmount.toFixed(2)),
    rate: Number.isFinite(account) ? account : null,
    list_rate: Number.isFinite(list) ? list : null,
    retail_rate: Number.isFinite(retail) ? retail : null,
    currency: ground.currency || "USD",
    delivery_days: ground.delivery_days ?? ground.est_delivery_days ?? null,
    delivery_date: ground.delivery_date || null,
    rate_id: ground.id || null,
    shipment_id: body.id || null,
    carrier_account_id: ground.carrier_account_id || null,
    messages: Array.isArray(body.messages) ? body.messages : []
  };
}

export function storefrontOriginAddress(settings = {}) {
  return {
    name: settings.shipping_return_name || "Friends of 323",
    street1: settings.shipping_return_address_line_1,
    street2: settings.shipping_return_address_line_2,
    city: settings.shipping_return_city,
    state: settings.shipping_return_state,
    zip: settings.shipping_return_postal_code
  };
}

export function packageParcel(pkg, contentsWeightOunces) {
  return {
    length: Number(pkg.package_length_inches),
    width: Number(pkg.package_width_inches),
    height: Number(pkg.package_height_inches),
    weight: Number((Number(pkg.package_weight_ounces || 0) + Number(contentsWeightOunces || 0)).toFixed(2))
  };
}
