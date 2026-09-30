import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.3/+esm";
import { sandboxConfig } from "../../sandbox-config.js";
if (!sandboxConfig.supabaseUrl || !sandboxConfig.supabasePublishableKey) {
  throw new Error("Configure the separate PayPal test database in sandbox-config.js before using the portal.");
}
if (new URL(sandboxConfig.supabaseUrl).hostname === "vwzzupezgiffqgmmhxed.supabase.co") {
  throw new Error("The PayPal test repository cannot use the current live Stripe database.");
}
export const supabase = createClient(sandboxConfig.supabaseUrl, sandboxConfig.supabasePublishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "friends323-paypal-sandbox-auth" }
});
