import { supabase } from "./supabase-client.js";
import { PATHS, clearMessage, setBusy, showMessage } from "./auth-common.js";

const form = document.querySelector("#password-form");
const button = document.querySelector("#password-button");
const message = document.querySelector("#password-message");

// Supabase invitation and password-recovery links establish an authenticated
// session before the password can be changed. Keep the form unavailable until
// that callback/session has been validated.
form.hidden = true;

let linkIsReady = false;
let validationFinished = false;

function getCallbackError() {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));

  return (
    query.get("error_description") ||
    hash.get("error_description") ||
    query.get("error") ||
    hash.get("error") ||
    ""
  );
}

function showReadyState() {
  if (linkIsReady) return;

  linkIsReady = true;
  validationFinished = true;
  clearMessage(message);
  form.hidden = false;
  button.disabled = false;
}

function showInvalidState(detail = "") {
  if (linkIsReady) return;

  validationFinished = true;
  form.hidden = true;

  const suffix = detail ? ` (${detail})` : "";
  showMessage(
    message,
    `This password link is invalid or expired. Request a new invitation or reset email.${suffix}`,
    "error"
  );
}

async function initializePasswordLink() {
  const callbackError = getCallbackError();
  if (callbackError) {
    showInvalidState(callbackError);
    return;
  }

  // If Supabase returns a PKCE authorization code, exchange it explicitly.
  // Implicit-flow callbacks continue to be handled automatically from the hash.
  const query = new URLSearchParams(window.location.search);
  const code = query.get("code");
  if (code) {
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError) {
      showInvalidState(exchangeError.message);
      return;
    }
  }

  // Listen before checking the current session so we do not miss the auth
  // event emitted while Supabase processes the URL callback.
  const {
    data: { subscription }
  } = supabase.auth.onAuthStateChange((event, session) => {
    if (
      session &&
      (event === "PASSWORD_RECOVERY" ||
        event === "SIGNED_IN" ||
        event === "INITIAL_SESSION" ||
        event === "TOKEN_REFRESHED")
    ) {
      showReadyState();
    }
  });

  try {
    const {
      data: { session },
      error
    } = await supabase.auth.getSession();

    if (error) {
      showInvalidState(error.message);
      return;
    }

    if (session) {
      showReadyState();
      return;
    }

    // detectSessionInUrl processes invitation/recovery callbacks
    // asynchronously. Give it a brief opportunity to establish the session
    // before deciding the link is unusable.
    await new Promise((resolve) => window.setTimeout(resolve, 2500));

    if (linkIsReady) return;

    const {
      data: { session: retrySession },
      error: retryError
    } = await supabase.auth.getSession();

    if (retryError) {
      showInvalidState(retryError.message);
      return;
    }

    if (retrySession) {
      showReadyState();
      return;
    }

    showInvalidState();
  } finally {
    // Once validation is complete, the password form no longer needs the
    // callback listener. Do not unsubscribe while URL processing is pending.
    if (validationFinished) {
      subscription.unsubscribe();
    }
  }
}

await initializePasswordLink();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage(message);

  if (!linkIsReady) {
    showInvalidState();
    return;
  }

  const data = new FormData(form);
  const password = String(data.get("password") || "");
  const confirmPassword = String(data.get("confirmPassword") || "");

  if (password.length < 8) {
    showMessage(message, "The password must contain at least eight characters.", "error");
    return;
  }

  if (password !== confirmPassword) {
    showMessage(message, "The passwords do not match.", "error");
    return;
  }

  setBusy(button, true, "Saving…");

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    showMessage(message, error.message, "error");
    setBusy(button, false);
    return;
  }

  showMessage(message, "Your password was saved. Redirecting…", "success");
  window.setTimeout(() => window.location.replace(PATHS.dashboard), 800);
});
