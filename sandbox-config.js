// Public project configuration only. Keep service-role keys and PayPal secrets out of this file.
export const sandboxConfig = Object.freeze({
  supabaseUrl: "https://vwzzupezgiffqgmmhxed.supabase.co",
  supabasePublishableKey: "sb_publishable_PQSBdKY-MdvLsFHvzGGwZA_yViiDczS",
  paypalEnvironment: "sandbox",
  // Staff functions use existing live records, under the existing role permissions.
  sharedLiveDataEnabled: true
});
