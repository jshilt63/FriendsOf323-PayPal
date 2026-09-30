// Public project configuration only. Keep service-role keys and PayPal secrets out of this file.
export const sandboxConfig = Object.freeze({
  supabaseUrl: "https://vwzzupezgiffqgmmhxed.supabase.co",
  supabasePublishableKey: "sb_publishable_PQSBdKY-MdvLsFHvzGGwZA_yViiDczS",
  paypalEnvironment: "sandbox",
  // Leave false until all portal reads/writes are routed to isolated sandbox tables.
  sandboxDataReady: false
});
