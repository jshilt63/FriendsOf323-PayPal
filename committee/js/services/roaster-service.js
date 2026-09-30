import { supabase } from "../../assets/supabase-client.js";
import { unwrap } from "./service-utils.js";
import { isReadyToOrder } from "../shared/order-workflow.js";

const SELECT = `
  id,
  order_number,
  ecwid_order_number,
  order_date,
  record_status,
  payment_status,
  wholesaler_status,
  delivery_status,
  customers(first_name,last_name,company_name,email,phone),
  order_items(
    id,
    quantity,
    notes,
    products(
      id,
      sku,
      product_name,
      bag_size,
      supplier_name,
      supplier_product_name
    ),
    scouts(first_name,last_name,is_general_fund)
  )
`;

export const RoasterService = {
  async readyToOrder() {
    const result = await supabase
      .from("orders")
      .select(SELECT)
      .eq("record_status", "active")
      .order("order_date")
      .order("order_number");

    return unwrap(result, "Ready-to-order records could not be loaded.")
      .filter(isReadyToOrder);
  },

  async markOrdered(orderId, userId) {
    return unwrap(
      await supabase
        .from("orders")
        .update({
          wholesaler_status: "submitted",
          updated_by: userId
        })
        .eq("id", orderId),
      "The order could not be marked as ordered."
    );
  }
};
