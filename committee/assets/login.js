import { supabase } from "./supabase-client.js";
import { PATHS, clearMessage, getCurrentUserProfile, redirectAuthenticatedUser, setBusy, showMessage } from "./auth-common.js";

await redirectAuthenticatedUser();

const form = document.querySelector("#login-form");
const button = document.querySelector("#login-button");
const message = document.querySelector("#login-message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage(message);
  setBusy(button, true, "Signing in…");

  const data = new FormData(form);
  const email = String(data.get("email") || "").trim();
  const password = String(data.get("password") || "");

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    showMessage(message, error.message, "error");
    setBusy(button, false);
    return;
  }

  const { profile } = await getCurrentUserProfile();
  window.location.replace(profile?.role === "treasurer" ? PATHS.treasury : PATHS.dashboard);
});
