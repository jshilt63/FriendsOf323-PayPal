import { supabase } from "../../assets/supabase-client.js";
import { unwrap } from "./service-utils.js";

export const PurchaseOrdersService = {
  async list(status = null) {
    let query = supabase
      .from("purchase_order_summary")
      .select("*")
      .order("order_date", { ascending: false })
      .order("po_number", { ascending: false });

    if (status) query = query.eq("status", status);

    return unwrap(
      await query,
      "Purchase orders could not be loaded."
    );
  },

  async get(id) {
    const [orderResult, itemsResult, allocationsResult, manualItemsResult] = await Promise.all([
      supabase
        .from("purchase_orders")
        .select("*")
        .eq("id", id)
        .single(),
      supabase
        .from("purchase_order_item_summary")
        .select("*")
        .eq("purchase_order_id", id)
        .order("supplier_product_name")
        .order("grind"),
      supabase
        .from("purchase_order_allocation_detail")
        .select("*")
        .eq("purchase_order_id", id)
        .order("supplier_product_name")
        .order("grind")
        .order("order_number"),
      supabase
        .from("purchase_order_manual_item_detail")
        .select("*")
        .eq("purchase_order_id", id)
        .order("supplier_product_name")
        .order("recipient_name")
    ]);

    return {
      purchaseOrder: unwrap(orderResult, "Purchase order could not be loaded."),
      items: unwrap(itemsResult, "Purchase-order items could not be loaded."),
      allocations: unwrap(allocationsResult, "Purchase-order allocations could not be loaded."),
      manualItems: unwrap(manualItemsResult, "Manual purchase-order lines could not be loaded.")
    };
  },

  async readyItems() {
    return unwrap(
      await supabase
        .from("ready_to_order_items")
        .select("*")
        .order("supplier_name")
        .order("supplier_product_name")
        .order("grind")
        .order("order_number"),
      "Ready-to-order items could not be loaded."
    );
  },

  async createDraft({ supplierName, lines, notes = null }) {
    const result = await supabase.rpc("create_draft_purchase_order", {
      p_supplier_name: supplierName,
      p_lines: lines,
      p_notes: notes
    });

    return unwrap(result, "The draft purchase order could not be created.");
  },

  async allocationDetails(purchaseOrderId) {
    return unwrap(
      await supabase
        .from("purchase_order_allocation_detail")
        .select("*")
        .eq("purchase_order_id", purchaseOrderId)
        .order("supplier_product_name")
        .order("grind")
        .order("order_number"),
      "Purchase-order allocations could not be loaded."
    );
  },

  async references() {
    const [products, customers] = await Promise.all([
      supabase.from("products").select("id,product_name,sku,bag_size,supplier_name,cost").order("product_name"),
      supabase.from("customers").select("id,first_name,last_name,company_name,address_line_1,address_line_2,city,state,postal_code,email,phone").order("last_name").order("first_name")
    ]);
    return {
      products: unwrap(products, "Products could not be loaded."),
      customers: unwrap(customers, "Customers could not be loaded.")
    };
  },

  async addManualItem(payload) {
    return unwrap(
      await supabase.from("purchase_order_manual_items").insert(payload).select().single(),
      "The manual purchase-order line could not be added."
    );
  },

  async deleteManualItem(id) {
    return unwrap(
      await supabase.from("purchase_order_manual_items").delete().eq("id", id),
      "The manual purchase-order line could not be removed."
    );
  },

  async deliveryItems() {
    return unwrap(
      await supabase.from("customer_delivery_item_detail")
        .select("*")
        .order("customer_name")
        .order("order_number")
        .order("product_name"),
      "Customer delivery information could not be loaded."
    );
  },

  async openExceptions() {
    return unwrap(
      await supabase.from("customer_fulfillment_exceptions")
        .select("*,order_items(order_id,products(product_name))")
        .is("resolved_at", null)
        .order("created_at"),
      "Fulfillment exceptions could not be loaded."
    );
  },

  async addException(payload) {
    return unwrap(
      await supabase.from("customer_fulfillment_exceptions").insert(payload).select().single(),
      "The outstanding-item exception could not be saved."
    );
  },

  async resolveException(id, userId) {
    return unwrap(
      await supabase.from("customer_fulfillment_exceptions")
        .update({ resolved_at: new Date().toISOString(), resolved_by: userId, updated_by: userId })
        .eq("id", id),
      "The outstanding-item exception could not be resolved."
    );
  },

  async refreshDraft(purchaseOrderId) {
    return unwrap(
      await supabase.rpc("refresh_draft_purchase_order", {
        p_purchase_order_id: purchaseOrderId
      }),
      "The draft purchase order could not be refreshed."
    );
  },

  async supplierEmail(supplierName) {
    const rows = unwrap(await supabase.from("purchase_order_supplier_settings")
      .select("po_email").eq("supplier_name", supplierName).limit(1), "Roaster email could not be loaded.");
    return rows[0]?.po_email || "";
  },

  async submit(purchaseOrderId) {
    const { data: { session }, error: authError } = await supabase.auth.getSession();
    if (authError || !session?.access_token) throw new Error("Please sign in again before submitting this order.");
    const response = await fetch("/.netlify/functions/submit-purchase-order", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ purchase_order_id: purchaseOrderId })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || "The purchase order could not be emailed.");
    return result;
  },

  async roasterFunding(purchaseOrderId) {
    const [setting, payouts] = await Promise.all([
      supabase.from("roaster_funding_settings").select("enabled").eq("id",1).single(),
      supabase.from("roaster_funding_payouts").select("id,amount,status,stripe_payout_id,stripe_arrival_date,failure_message").eq("purchase_order_id",purchaseOrderId).order("created_at",{ascending:false}).limit(1)
    ]);
    return { enabled: unwrap(setting,"Roaster funding setting could not be loaded.")?.enabled,
      payout: unwrap(payouts,"Roaster funding status could not be loaded.")[0]||null };
  },

  async createRoasterFunding(purchaseOrderId) {
    const {data:{session}}=await supabase.auth.getSession();
    if(!session?.access_token)throw new Error("Sign in again before creating a payout.");
    const response=await fetch("/.netlify/functions/create-roaster-funding-payout",{
      method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${session.access_token}`},
      body:JSON.stringify({purchase_order_id:purchaseOrderId})
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error||"Roaster funding payout failed.");
    return result;
  },

  async transition(purchaseOrderId, status) {
    return unwrap(
      await supabase.rpc("transition_purchase_order", {
        p_purchase_order_id: purchaseOrderId,
        p_status: status
      }),
      "The purchase-order status could not be updated."
    );
  }
};
