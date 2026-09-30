import { supabase } from "../../assets/supabase-client.js";
import { unwrap } from "./service-utils.js";
const ORDER_SELECT=`*, customers(id,first_name,last_name,company_name,email,address_line_1,address_line_2,city,state,postal_code,geocode_latitude,geocode_longitude,geocode_address,geocode_source,geocoded_at), order_items(id,product_id,scout_id,quantity,quantity_received,unit_price,unit_fundraising_credit,line_total,fundraising_credit_total,notes,products(product_name,sku,bag_size),scouts(first_name,last_name,is_general_fund,den_id,dens(den_number,current_rank_working_toward)))`;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getAccessToken() {
  const result = await withTimeout(
    supabase.auth.getSession(),
    12000,
    "Authentication timed out. Refresh the portal and sign in again if needed."
  );
  const { data, error } = result || {};
  if (error) throw error;
  const token = data?.session?.access_token;
  if (!token) throw new Error("Your session has expired. Sign in again.");
  return token;
}
export const OrdersService = {
  async references() {
    const [customers,products,scouts,dens]=await Promise.all([
      supabase.from("customers").select("*").order("last_name").order("first_name"),
      supabase.from("products").select("*").order("product_name"),
      supabase.from("scouts").select("*,dens(den_number,current_rank_working_toward)").order("is_general_fund",{ascending:false}).order("last_name").order("first_name"),
      supabase.from("dens").select("id,den_number,current_rank_working_toward")]);

    // Enrich scout den data explicitly as a fallback. This prevents the order
    // importer/search UI from showing "No den assigned" when a scout has a
    // den_id but the nested relationship is not populated in the response.
    const scoutRows=unwrap(scouts);
    const denRows=unwrap(dens);
    const densById=new Map((denRows||[]).map(den=>[den.id,den]));
    const enrichedScouts=(scoutRows||[]).map(scout=>({
      ...scout,
      dens: scout.dens || densById.get(scout.den_id) || null
    }));

    return {customers:unwrap(customers),products:unwrap(products),scouts:enrichedScouts};
  },
  async list() { return unwrap(await supabase.from("orders").select(ORDER_SELECT).order("order_date",{ascending:false}).order("order_number",{ascending:false})); },
  async getShippingLabelSettings() {
    return unwrap(await supabase.from("storefront_settings")
      .select("shipping_return_name,shipping_return_address_line_1,shipping_return_address_line_2,shipping_return_city,shipping_return_state,shipping_return_postal_code")
      .eq("id",1).maybeSingle(), "Shipping-label settings could not be loaded.") || {};
  },
  async createCustomer(payload) { return unwrap(await supabase.from("customers").insert(payload).select().single()); },
  async listDeliveryEligibility() {
    return unwrap(await supabase
      .from("order_delivery_eligibility")
      .select("order_id,status,address_snapshot,matches,route_config_updated_at,checked_at,error_message,manual_local_override,manual_local_reason,manual_local_at,manual_local_by")
      .order("checked_at", { ascending:false }), "Delivery eligibility could not be loaded.");
  },

  async listActiveDeliveryAreas() {
    const [driversResult, routesResult] = await Promise.all([
      supabase.from("delivery_drivers").select("id,display_name,is_active,updated_at").eq("is_active", true),
      supabase.from("delivery_driver_routes")
        .select("id,driver_id,route_name,coverage_type,allowed_distance_miles,geometry,center_address,center_latitude,center_longitude,is_active,updated_at")
        .eq("is_active", true)
    ]);
    const drivers = unwrap(driversResult, "Delivery drivers could not be loaded.");
    const routes = unwrap(routesResult, "Delivery areas could not be loaded.");
    const driverMap = new Map(drivers.map(driver => [driver.id, driver]));
    return routes
      .filter(route => driverMap.has(route.driver_id))
      .map(route => {
        const driver = driverMap.get(route.driver_id);
        return {
          ...route,
          driver_name: driver.display_name,
          driver_updated_at: driver.updated_at
        };
      });
  },

  async geocodeAddress(address) {
    const token = await getAccessToken();
    const response = await fetch("/.netlify/functions/geocode-address", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ address })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Address lookup failed (${response.status}).`);
    return body;
  },

  async saveCustomerGeocode(customerId, values) {
    return unwrap(await supabase.from("customers").update(values).eq("id", customerId).select("id").single(),
      "Customer coordinates could not be saved.");
  },

  async saveDeliveryEligibility(orderId, values) {
    const currentUser = (await supabase.auth.getUser()).data.user;
    return unwrap(await supabase.from("order_delivery_eligibility").upsert({
      order_id: orderId,
      ...values,
      checked_by: currentUser?.id || null
    }, { onConflict:"order_id" }).select("order_id,status,address_snapshot,matches,route_config_updated_at,checked_at,error_message,manual_local_override,manual_local_reason,manual_local_at,manual_local_by").single(),
    "Delivery eligibility could not be saved.");
  },

  async setManualLocalOverride(orderId, enabled, reason = null) {
    const currentUser = (await supabase.auth.getUser()).data.user;
    const values = enabled
      ? {
          manual_local_override: true,
          manual_local_reason: String(reason || "").trim(),
          manual_local_at: new Date().toISOString(),
          manual_local_by: currentUser?.id || null
        }
      : {
          manual_local_override: false,
          manual_local_reason: null,
          manual_local_at: null,
          manual_local_by: null
        };
    return unwrap(await supabase.from("order_delivery_eligibility")
      .update(values)
      .eq("order_id", orderId)
      .select("order_id,status,address_snapshot,matches,route_config_updated_at,checked_at,error_message,manual_local_override,manual_local_reason,manual_local_at,manual_local_by")
      .single(), "Local-delivery exception could not be saved.");
  },

  async save({id,order,itemPayloads}) {
    let orderId=id;
    if (!id) {
      orderId=unwrap(await supabase.from("orders").insert(order).select("id").single()).id;
      unwrap(await supabase.from("order_items").insert(
        itemPayloads.map(({id: _id, ...item}) => ({...item,order_id:orderId}))
      ));
      return orderId;
    }

    // Preserve existing order-item IDs. Purchase-order allocations reference these
    // rows, so deleting and recreating every line breaks the FK relationship.
    const existing = unwrap(await supabase
      .from("order_items")
      .select("id,product_id,quantity,quantity_received,notes")
      .eq("order_id", id));
    const existingById = new Map(existing.map(item => [item.id, item]));
    const keptIds = new Set(itemPayloads.map(item => item.id).filter(Boolean));
    const removedIds = existing.map(item => item.id).filter(itemId => !keptIds.has(itemId));

    const allocatedRows = existing.length
      ? unwrap(await supabase
          .from("purchase_order_allocations")
          .select("order_item_id,quantity_allocated")
          .in("order_item_id", existing.map(item => item.id)))
      : [];
    const allocated = new Map();
    for (const row of allocatedRows) {
      allocated.set(row.order_item_id, (allocated.get(row.order_item_id) || 0) + Number(row.quantity_allocated || 0));
    }

    if (removedIds.some(itemId => (allocated.get(itemId) || 0) > 0)) {
      throw new Error("A line on this order is already included on a purchase order and cannot be removed. Adjust or cancel that purchase order first.");
    }

    for (const item of itemPayloads) {
      if (!item.id) continue;
      const prior = existingById.get(item.id);
      if (!prior) throw new Error("An order line changed while this order was open. Reload the order and try again.");
      const allocatedQty = allocated.get(item.id) || 0;
      if (allocatedQty > 0 && item.product_id !== prior.product_id) {
        throw new Error("A product already included on a purchase order cannot be changed. Adjust or cancel that purchase order first.");
      }
      if (allocatedQty > Number(item.quantity || 0)) {
        throw new Error(`This line already has ${allocatedQty} bag(s) allocated to a purchase order, so its quantity cannot be reduced below ${allocatedQty}.`);
      }
      if (allocatedQty > 0 && item.notes !== prior.notes) {
        throw new Error("The grind for a line already included on a purchase order cannot be changed. Adjust or cancel that purchase order first.");
      }
    }

    unwrap(await supabase.from("orders").update(order).eq("id",id));

    for (const item of itemPayloads) {
      const {id:itemId, ...values} = item;
      if (itemId) {
        delete values.created_by;
        unwrap(await supabase.from("order_items").update(values).eq("id",itemId));
      } else {
        unwrap(await supabase.from("order_items").insert({...values,order_id:id}));
      }
    }

    if (removedIds.length) {
      unwrap(await supabase.from("order_items").delete().in("id",removedIds));
    }

    return orderId;
  },
  async markAllReceived(id,userId) {
    const items=unwrap(await supabase.from("order_items").select("id,quantity").eq("order_id",id));
    for (const item of items) {
      unwrap(await supabase.from("order_items").update({quantity_received:item.quantity,updated_by:userId}).eq("id",item.id));
    }
    return unwrap(await supabase.from("orders").update({wholesaler_status:"received",updated_by:userId}).eq("id",id));
  },
  async voidOrder(id,reason,userId) {
    return unwrap(await supabase.from("orders").update({
      record_status:"voided",
      void_reason:reason,
      voided_by:userId,
      voided_at:new Date().toISOString(),
      updated_by:userId
    }).eq("id",id));
  },
  async cancelAndRefund(id,reason) {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;
    const token = sessionData?.session?.access_token;
    if (!token) throw new Error("Your session has expired. Sign in again before issuing a refund.");

    const response = await fetch("/.netlify/functions/refund-order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ order_id:id, reason })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Stripe refund failed.");
    return body;
  },
  async restoreOrder(id,userId) {
    return unwrap(await supabase.from("orders").update({
      record_status:"active",
      void_reason:null,
      voided_by:null,
      voided_at:null,
      updated_by:userId
    }).eq("id",id));
  },
  async updateStatus(id,updates) { return unwrap(await supabase.from("orders").update(updates).eq("id",id)); },
  async getEasyPostShippingLabel(orderId, { confirmPurchase = true, onProgress = null } = {}) {
    onProgress?.("Authenticating…");
    const token = await getAccessToken();

    onProgress?.("Contacting EasyPost label service…");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await fetch("/.netlify/functions/easypost-shipping-label", {
        method: "POST",
        headers: { "Content-Type":"application/json", Authorization:`Bearer ${token}` },
        body: JSON.stringify({ order_id:orderId, confirm_purchase:confirmPurchase }),
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("The EasyPost label request timed out after 30 seconds. Check the Netlify easypost-shipping-label function log.");
      }
      throw new Error(`The EasyPost label service could not be reached: ${error?.message || "network error"}`);
    } finally {
      clearTimeout(timer);
    }

    onProgress?.("EasyPost responded; validating label…");
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `EasyPost shipping label failed (${response.status}).`);
    if (!body?.label_url) throw new Error("EasyPost responded without a printable postage label. No print job was created.");
    if (!body?.label_data_url) throw new Error("The carrier label was returned, but its image could not be prepared for framed printing.");
    onProgress?.("Carrier label image received…");
    return body;
  },
  async markShippingLabelsPrinted(orderIds,userId) {
    const ids = [...new Set((orderIds || []).filter(Boolean))];
    if (!ids.length) return [];
    const printedAt = new Date().toISOString();
    return unwrap(await supabase.from("orders")
      .update({ shipping_label_printed_at: printedAt, shipping_label_printed_by: userId || null, updated_by: userId || null })
      .in("id", ids)
      .select("id,shipping_label_printed_at,shipping_label_printed_by"),
      "Shipping-label print status could not be saved.");
  }
};
