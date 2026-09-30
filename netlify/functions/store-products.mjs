export default async () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({
        error: "Store database configuration is missing."
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/products` +
        `?select=id,sku,product_name,bag_size,sale_price,is_active` +
        `&is_active=eq.true` +
        `&order=product_name.asc,bag_size.asc`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`
        }
      }
    );

    if (!response.ok) {
      const details = await response.text();

      console.error("Supabase product query failed:", details);

      return new Response(
        JSON.stringify({
          error: "Unable to load store products."
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    const products = await response.json();

    return new Response(
      JSON.stringify({
        products
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    console.error("Store product function error:", error);

    return new Response(
      JSON.stringify({
        error: "Unable to load store products."
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
};
