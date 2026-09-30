import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.3/+esm";
import { sandboxConfig } from "../../sandbox-config.js";
if (sandboxConfig.paypalEnvironment !== "sandbox") {
  throw new Error("This development repository requires PayPal sandbox mode.");
}
if (!sandboxConfig.supabaseUrl || !sandboxConfig.supabasePublishableKey) {
  throw new Error("Configure the shared Supabase project in sandbox-config.js.");
}
export const supabase = createClient(sandboxConfig.supabaseUrl, sandboxConfig.supabasePublishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "friends323-paypal-sandbox-auth" }
});
