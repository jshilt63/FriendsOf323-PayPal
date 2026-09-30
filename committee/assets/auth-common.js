import { supabase } from "./supabase-client.js";

export const PATHS = {
  login: "/committee/login.html",
  dashboard: "/committee/dashboard.html",
  treasury: "/committee/treasury.html",
  setPassword: "/committee/set-password.html",
  resetPassword: "/committee/reset-password.html"
};

export function showMessage(element, message, type = "info") {
  if (!element) return;
  element.textContent = message;
  element.className = `auth-message auth-message--${type}`;
  element.hidden = false;
}

export function clearMessage(element) {
  if (!element) return;
  element.textContent = "";
  element.hidden = true;
}

export function setBusy(button, busy, busyText = "Working…") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

export async function getCurrentUserProfile() {
  const { data: { user }, error: userError } = await supabase.auth.getUser();

  if (userError || !user) {
    return { user: null, profile: null, error: userError };
  }

  const { data: profile, error: profileError } = await supabase
    .from("user_profiles")
    .select("id, display_name, role, den_id, is_active")
    .eq("id", user.id)
    .single();

  return { user, profile, error: profileError };
}

export async function requirePortalUser({ redirectTo = PATHS.login, allowedRoles = null } = {}) {
  const result = await getCurrentUserProfile();

  if (!result.user || result.error || !result.profile?.is_active) {
    await supabase.auth.signOut();
    window.location.replace(redirectTo);
    return null;
  }

  if (allowedRoles && !allowedRoles.includes(result.profile.role)) {
    window.location.replace(result.profile.role === "treasurer" ? PATHS.treasury : PATHS.dashboard);
    return null;
  }

  return result;
}

export async function redirectAuthenticatedUser() {
  const result = await getCurrentUserProfile();
  if (result.user && result.profile?.is_active) {
    window.location.replace(result.profile.role === "treasurer" ? PATHS.treasury : PATHS.dashboard);
    return true;
  }
  return false;
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.replace(PATHS.login);
}
