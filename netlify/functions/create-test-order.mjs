const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS
  });
}

function nonEmptyText(value, maxLength = 500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export default async (request) => {
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, {
      error: "Store database configuration is missing."
    });
  }

  let payload;

  try {
    payload = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid request body." });
  }

  const customerInput = payload?.customer ?? {};
  const itemsInput = Array.isArray(payload?.items) ? payload.items : [];
  const processingCost = Number(payload?.processing_cost ?? 0);

  const customer = {
    first_name: nonEmptyText(customerInput.first_name, 100),
    last_name: nonEmptyText(customerInput.last_name, 100),
    email: nonEmptyText(customerInput.email, 254).toLowerCase(),
    phone: nonEmptyText(customerInput.phone, 50),
    address_line_1: nonEmptyText(customerInput.address_line_1, 200),
    address_line_2: nonEmptyText(customerInput.address_line_2, 200),
    city: nonEmptyText(customerInput.city, 120),
    state: nonEmptyText(customerInput.state, 20).toUpperCase(),
    postal_code: nonEmptyText(customerInput.postal_code, 20)
  };

  if (
    !customer.first_name ||
    !customer.last_name ||
    !validEmail(customer.email) ||
    !customer.address_line_1 ||
    !customer.city ||
    !customer.state ||
    !customer.postal_code
  ) {
    return jsonResponse(400, {
      error: "Required customer information is missing or invalid."
    });
  }

  if (!Number.isFinite(processingCost) || processingCost < 0 || processingCost > 100) {
    return jsonResponse(400, {
      error: "Processing cost is invalid."
    });
  }

  if (!itemsInput.length || itemsInput.length > 50) {
    return jsonResponse(400, {
      error: "At least one valid coffee item is required."
    });
  }

  const items = [];

  for (const item of itemsInput) {
    const quantity = Number(item?.quantity);
    const grind = item?.grind;
    const allocationsInput = Array.isArray(item?.allocations) ? item.allocations : [];

    if (
      typeof item?.product_id !== "string" ||
      !item.product_id ||
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      quantity > 100 ||
      !["whole_bean", "ground"].includes(grind) ||
      !allocationsInput.length
    ) {
      return jsonResponse(400, {
        error: "One or more coffee items are invalid."
      });
    }

    let allocatedTotal = 0;
    const allocations = [];

    for (const allocation of allocationsInput) {
      const allocationQuantity = Number(allocation?.quantity);

      if (
        typeof allocation?.scout_id !== "string" ||
        !allocation.scout_id ||
        !Number.isInteger(allocationQuantity) ||
        allocationQuantity <= 0 ||
        allocationQuantity > quantity
      ) {
        return jsonResponse(400, {
          error: "One or more Scout allocations are invalid."
        });
      }

      allocatedTotal += allocationQuantity;

      allocations.push({
        scout_id: allocation.scout_id,
        quantity: allocationQuantity
      });
    }

    if (allocatedTotal !== quantity) {
      return jsonResponse(400, {
        error: "Scout allocations must equal the coffee quantity."
      });
    }

    items.push({
      product_id: item.product_id,
      grind,
      quantity,
      allocations
    });
  }

  try {
    const rpcResponse = await fetch(
      `${supabaseUrl}/rest/v1/rpc/create_storefront_order`,
      {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          p_customer: customer,
          p_items: items,
          p_processing_cost: processingCost
        })
      }
    );

    const responseText = await rpcResponse.text();
    let rpcResult = {};

    try {
      rpcResult = responseText ? JSON.parse(responseText) : {};
    } catch {
      rpcResult = {};
    }

    if (!rpcResponse.ok) {
      console.error("create_storefront_order RPC failed:", {
        status: rpcResponse.status,
        details: responseText
      });

      return jsonResponse(500, {
        error: "The storefront order could not be created."
      });
    }

    return jsonResponse(201, {
      order_id: rpcResult.order_id,
      order_number: rpcResult.order_number,
      store_order_number: rpcResult.store_order_number,
      customer_id: rpcResult.customer_id,
      payment_status: rpcResult.payment_status,
      wholesaler_status: "not_ready",
      order_source: rpcResult.order_source
    });
  } catch (error) {
    console.error("Create test order function error:", error);

    return jsonResponse(500, {
      error: "The storefront order could not be created."
    });
  }
};
