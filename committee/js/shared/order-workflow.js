export const ORDER_WORKFLOW = Object.freeze({
  payment: { label: "Awaiting Payment", tone: "warning" },
  roaster: { label: "Ready to Order", tone: "orange" },
  partial_order: { label: "Partially Ordered", tone: "orange" },
  processing: { label: "Roaster Processing", tone: "info" },
  partial_received: { label: "Partially Received", tone: "info" },
  received: { label: "Coffee Received", tone: "purple" },
  pickup: { label: "Ready for Pickup", tone: "success" },
  shipping_ready: { label: "Ready to Ship", tone: "success" },
  shipped: { label: "Shipped", tone: "info" },
  delivered: { label: "Delivered", tone: "complete" },
  voided: { label: "Voided", tone: "dark" }
});

export function getOrderWorkflow(order) {
  if (order.record_status === "voided") return workflow("voided");
  if (order.fulfillment_method === "shipping") {
    if (order.shipping_status === "delivered" || order.delivery_status === "delivered") return workflow("delivered");
    if (order.shipping_status === "shipped") return workflow("shipped");
    if (order.shipping_status === "ready_to_ship") return workflow("shipping_ready");
  }
  if (order.delivery_status === "delivered") return workflow("delivered");
  if (order.delivery_status === "ready_for_pickup" ||
      order.delivery_status === "out_for_delivery") return workflow("pickup");
  if (order.wholesaler_status === "received") return workflow("received");
  if (order.wholesaler_status === "partially_ordered") return workflow("partial_order");
  if (order.wholesaler_status === "in_process") return workflow("partial_received");
  if (order.wholesaler_status === "submitted") return workflow("processing");
  if (order.payment_status === "unpaid" ||
      order.payment_status === "partially_paid") return workflow("payment");

  // A fully paid active order that has not yet been sent to a supplier is
  // operationally Ready to Order, even when an older record still contains
  // wholesaler_status = not_ready.
  return workflow("roaster");
}

export function isReadyToOrder(order) {
  return getOrderWorkflow(order).key === "roaster";
}

function workflow(key) {
  return { key, ...ORDER_WORKFLOW[key] };
}
