// Route Supabase auth callbacks that fall back to the configured Site URL.
// This protects invitation/recovery flows even when Supabase ignores or rejects
// a requested redirect URL and returns the user to the public home page.
(() => {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const type = hash.get("type") || query.get("type") || "";
  const hasAuthPayload = Boolean(
    hash.get("access_token") ||
    hash.get("error") ||
    hash.get("error_description") ||
    query.get("code") ||
    query.get("error") ||
    query.get("error_description")
  );

  if (!hasAuthPayload) return;

  let destination = "";
  if (type === "invite") destination = "/committee/set-password.html";
  if (type === "recovery") destination = "/committee/reset-password.html";
  if (!destination) return;

  window.location.replace(`${destination}${window.location.search}${window.location.hash}`);
})();
