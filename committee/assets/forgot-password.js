import { supabase } from "./supabase-client.js";
import { clearMessage, setBusy, showMessage } from "./auth-common.js";

const form = document.querySelector("#forgot-form");
const button = document.querySelector("#forgot-button");
const message = document.querySelector("#forgot-message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage(message);
  setBusy(button, true, "Sending…");

  const email = String(new FormData(form).get("email") || "").trim();
  const redirectTo = `${window.location.origin}/committee/reset-password.html`;

  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  setBusy(button, false);

  if (error) {
    showMessage(message, error.message, "error");
    return;
  }

  showMessage(message, "Check your email for the password-reset link.", "success");
  form.reset();
});
