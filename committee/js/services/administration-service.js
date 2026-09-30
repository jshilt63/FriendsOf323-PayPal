import { supabase } from "../../assets/supabase-client.js";
import { unwrap } from "./service-utils.js";

async function getAccessToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(error.message);
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has expired. Sign in again.");
  return token;
}

async function callAdminFunction(action, payload = {}) {
  const token = await getAccessToken();
  const response = await fetch("/.netlify/functions/committee-admin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ action, ...payload })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Administration request failed (${response.status}).`);
  }
  return body;
}

export const AdministrationService = {
  async listUsers() {
    return callAdminFunction("list_users");
  },

  async inviteUser({ email, displayName, role, denId }) {
    return callAdminFunction("invite_user", {
      email,
      display_name: displayName,
      role,
      den_id: denId || null
    });
  },

  async resendInvite(userId) {
    return callAdminFunction("resend_invite", { user_id: userId });
  },

  async sendPasswordReset(userId) {
    return callAdminFunction("send_password_reset", { user_id: userId });
  },

  async updateUserProfile(userId, changes) {
    const result = await supabase
      .from("user_profiles")
      .update({
        ...changes,
        updated_at: new Date().toISOString()
      })
      .eq("id", userId)
      .select("id,display_name,role,is_active,receive_order_notifications,den_id,created_at,updated_at")
      .single();
    return unwrap(result, "User profile could not be updated.");
  },

  async listDens() {
    return unwrap(await supabase.from("dens").select("id,den_number,current_rank_working_toward,active").eq("active",true).order("den_number"));
  },


  async listDrivers() {
    const [drivers, routes] = await Promise.all([
      unwrap(await supabase
        .from("delivery_drivers")
        .select("id,display_name,email,phone,starting_area,notes,user_profile_id,is_active,created_at,updated_at")
        .order("display_name"), "Drivers could not be loaded."),
      unwrap(await supabase
        .from("delivery_driver_routes")
        .select("id,driver_id,route_name,route_type,coverage_type,description,allowed_distance_miles,is_active,source_filename,source_format,geometry,point_count,bounds,center_address,center_latitude,center_longitude,imported_at,created_at,updated_at")
        .order("route_name"), "Driver routes could not be loaded.")
    ]);

    const routesByDriver = new Map();
    routes.forEach(route => {
      if (!routesByDriver.has(route.driver_id)) routesByDriver.set(route.driver_id, []);
      routesByDriver.get(route.driver_id).push(route);
    });

    return drivers.map(driver => ({
      ...driver,
      routes: routesByDriver.get(driver.id) || []
    }));
  },

  async createDriver(values) {
    const user = (await supabase.auth.getUser()).data.user;
    return unwrap(await supabase
      .from("delivery_drivers")
      .insert({ ...values, created_by: user?.id || null, updated_by: user?.id || null })
      .select("id")
      .single(), "Driver could not be created.");
  },

  async updateDriver(driverId, values) {
    const user = (await supabase.auth.getUser()).data.user;
    return unwrap(await supabase
      .from("delivery_drivers")
      .update({ ...values, updated_by: user?.id || null })
      .eq("id", driverId)
      .select("id")
      .single(), "Driver could not be updated.");
  },

  async deleteDriver(driverId) {
    return unwrap(await supabase
      .from("delivery_drivers")
      .delete()
      .eq("id", driverId)
      .select("id"), "Driver could not be deleted.");
  },

  async saveImportedRoute(routeId, values) {
    const user = (await supabase.auth.getUser()).data.user;
    if (routeId) {
      return unwrap(await supabase
        .from("delivery_driver_routes")
        .update({ ...values, updated_by: user?.id || null })
        .eq("id", routeId)
        .select("id")
        .single(), "Route could not be updated.");
    }

    return unwrap(await supabase
      .from("delivery_driver_routes")
      .insert({ ...values, created_by: user?.id || null, updated_by: user?.id || null })
      .select("id")
      .single(), "Route could not be imported.");
  },

  async updateRoute(routeId, values) {
    const user = (await supabase.auth.getUser()).data.user;
    return unwrap(await supabase
      .from("delivery_driver_routes")
      .update({ ...values, updated_by: user?.id || null })
      .eq("id", routeId)
      .select("id")
      .single(), "Route could not be updated.");
  },

  async deleteRoute(routeId) {
    return unwrap(await supabase
      .from("delivery_driver_routes")
      .delete()
      .eq("id", routeId)
      .select("id"), "Route could not be deleted.");
  },

  async listDeliveryCustomers() {
    return unwrap(await supabase
      .from("customers")
      .select("id,first_name,last_name,company_name,address_line_1,address_line_2,city,state,postal_code,geocode_latitude,geocode_longitude,geocode_address,geocode_source,geocoded_at")
      .order("last_name")
      .order("first_name"), "Customer addresses could not be loaded.");
  },

  async geocodeAddress(address) {
    const token = await getAccessToken();
    const response = await fetch("/.netlify/functions/geocode-address", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ address })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Address lookup failed (${response.status}).`);
    return body;
  },

  async saveCustomerGeocode(customerId, values) {
    return unwrap(await supabase
      .from("customers")
      .update(values)
      .eq("id", customerId)
      .select("id")
      .single(), "Customer coordinates could not be saved.");
  },

  async getStoreNoticeSettings() {
    const result = await supabase
      .from("storefront_settings")
      .select("id,announcement_enabled,announcement_title,announcement_message,updated_at")
      .eq("id", 1)
      .maybeSingle();
    return unwrap(result, "Store notice settings could not be loaded.") || {
      id:1, announcement_enabled:false,
      announcement_title:"Our Bean Acquisition Clerk Is On Vacation",
      announcement_message:""
    };
  },

  async saveStoreNoticeSettings(values) {
    const user = (await supabase.auth.getUser()).data.user;
    const payload = { updated_by:user?.id || null };
    for (const field of ["announcement_enabled", "announcement_title", "announcement_message"]) {
      if (!Object.prototype.hasOwnProperty.call(values, field)) continue;
      payload[field] = field === "announcement_enabled" ? Boolean(values[field]) : String(values[field] ?? "").trim();
    }
    return unwrap(await supabase
      .from("storefront_settings")
      .update(payload)
      .eq("id", 1)
      .select("id,announcement_enabled,announcement_title,announcement_message,updated_at")
      .single(), "Store notice settings could not be saved.");
  },

  async getShippingSettings() {
    const result = await supabase
      .from("storefront_settings")
      .select("id,shipping_enabled,shipping_packaging_charge,shipping_return_name,shipping_return_address_line_1,shipping_return_address_line_2,shipping_return_city,shipping_return_state,shipping_return_postal_code,updated_at")
      .eq("id", 1)
      .maybeSingle();
    return unwrap(result, "Shipping settings could not be loaded.") || { id:1, shipping_enabled:false };
  },

  async saveShippingSettings(values) {
    const user = (await supabase.auth.getUser()).data.user;
    const payload = { updated_by:user?.id || null };
    const editableFields = [
      "shipping_enabled",
      "shipping_packaging_charge",
      "shipping_return_name",
      "shipping_return_address_line_1",
      "shipping_return_address_line_2",
      "shipping_return_city",
      "shipping_return_state",
      "shipping_return_postal_code"
    ];

    for (const field of editableFields) {
      if (!Object.prototype.hasOwnProperty.call(values, field)) continue;
      payload[field] = field === "shipping_enabled"
        ? Boolean(values[field])
        : field === "shipping_packaging_charge"
          ? Math.max(0, Number(values[field] ?? 0))
          : (values[field] ?? null);
    }

    return unwrap(await supabase
      .from("storefront_settings")
      .update(payload)
      .eq("id", 1)
      .select("id,shipping_enabled,shipping_packaging_charge,shipping_return_name,shipping_return_address_line_1,shipping_return_address_line_2,shipping_return_city,shipping_return_state,shipping_return_postal_code,updated_at")
      .single(), "Shipping settings could not be saved.");
  },

  async listShippingRates() {
    return unwrap(await supabase
      .from("shipping_rate_tiers")
      .select("id,label,min_bags,max_bags,package_length_inches,package_width_inches,package_height_inches,package_weight_ounces,rate_amount,is_active,created_at,updated_at")
      .order("min_bags"), "Shipping rates could not be loaded.");
  },

  async saveShippingRate(rateId, values) {
    const user = (await supabase.auth.getUser()).data.user;
    if (rateId) {
      return unwrap(await supabase
        .from("shipping_rate_tiers")
        .update({ ...values, updated_by:user?.id || null })
        .eq("id", rateId)
        .select("id")
        .single(), "Shipping rate could not be updated.");
    }
    return unwrap(await supabase
      .from("shipping_rate_tiers")
      .insert({ ...values, created_by:user?.id || null, updated_by:user?.id || null })
      .select("id")
      .single(), "Shipping rate could not be created.");
  },


  async deleteShippingRate(rateId) {
    return unwrap(await supabase
      .from("shipping_rate_tiers")
      .delete()
      .eq("id", rateId), "Shipping package could not be deleted.");
  },

  async getAuditLog(limit = 250) {
    const result = await supabase
      .from("audit_log")
      .select("id,table_name,record_id,action,old_data,new_data,changed_by,changed_at")
      .order("changed_at", { ascending: false })
      .limit(limit);
    return unwrap(result, "Audit history could not be loaded.");
  }
};
