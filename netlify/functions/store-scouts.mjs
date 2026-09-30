export default async () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ error: "Store database configuration is missing." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  try {
    // Read only the fields the public checkout needs.
    // Den data is joined for a helpful display label; no contact/private data is exposed.
    const response = await fetch(
      `${supabaseUrl}/rest/v1/scouts` +
        `?select=id,first_name,last_name,is_general_fund,is_active,den_id,dens(den_number,current_rank_working_toward)` +
        `&is_active=eq.true` +
        `&order=is_general_fund.desc,first_name.asc,last_name.asc`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`
        }
      }
    );

    if (!response.ok) {
      const details = await response.text();
      console.error("Supabase scout query failed:", details);

      return new Response(
        JSON.stringify({ error: "Unable to load Scouts." }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const rows = await response.json();

    const scouts = rows.map(row => ({
      id: row.id,
      first_name: row.first_name,
      last_name: row.last_name,
      is_general_fund: row.is_general_fund,
      den_number: row.dens?.den_number ?? null,
      rank: row.dens?.current_rank_working_toward ?? null
    }));

    return new Response(
      JSON.stringify({ scouts }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    console.error("Store scout function error:", error);

    return new Response(
      JSON.stringify({ error: "Unable to load Scouts." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
};
