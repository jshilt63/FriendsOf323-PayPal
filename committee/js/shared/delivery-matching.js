export function customerAddress(customer = {}) {
  return [
    customer.address_line_1,
    customer.address_line_2,
    [customer.city, customer.state, customer.postal_code].filter(Boolean).join(" ")
  ].filter(Boolean).join(", ").trim();
}

export function evaluateDeliveryAreas(areas = [], latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

  return (areas || []).map(area => {
    const distance = distanceToCoverage(area, lat, lng);
    const allowed = Number(area.allowed_distance_miles || 0);
    return {
      route_id: area.id,
      driver_id: area.driver_id,
      driver_name: area.driver_name || "Driver",
      route_name: area.route_name || "Delivery area",
      coverage_type: area.coverage_type || "path",
      distance_miles: Number.isFinite(distance) ? roundMiles(distance) : null,
      allowed_distance_miles: allowed,
      eligible: Number.isFinite(distance) && distance <= allowed
    };
  }).sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return (a.distance_miles ?? Infinity) - (b.distance_miles ?? Infinity);
  });
}

export function distanceToCoverage(area, lat, lng) {
  if ((area.coverage_type || "path") === "radius") {
    return haversineMiles(lat, lng, Number(area.center_latitude), Number(area.center_longitude));
  }

  const lines = area.geometry?.coordinates || [];
  let best = Infinity;
  for (const line of lines) {
    if (!Array.isArray(line)) continue;
    for (let i = 1; i < line.length; i += 1) {
      const a = line[i - 1];
      const b = line[i];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      best = Math.min(best, pointToSegmentMiles(
        lat, lng,
        Number(a[1]), Number(a[0]),
        Number(b[1]), Number(b[0])
      ));
    }
    if (line.length === 1 && Array.isArray(line[0])) {
      best = Math.min(best, haversineMiles(lat, lng, Number(line[0][1]), Number(line[0][0])));
    }
  }
  return best;
}

function pointToSegmentMiles(lat, lng, lat1, lng1, lat2, lng2) {
  const meanLat = ((lat + lat1 + lat2) / 3) * Math.PI / 180;
  const milesPerDegLat = 69.0;
  const milesPerDegLng = 69.172 * Math.cos(meanLat);
  const px = lng * milesPerDegLng;
  const py = lat * milesPerDegLat;
  const ax = lng1 * milesPerDegLng;
  const ay = lat1 * milesPerDegLat;
  const bx = lng2 * milesPerDegLng;
  const by = lat2 * milesPerDegLat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return Infinity;
  const r = 3958.7613;
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function roundMiles(value) {
  return Math.round(Number(value) * 100) / 100;
}
