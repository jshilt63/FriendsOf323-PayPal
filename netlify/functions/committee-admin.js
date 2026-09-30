const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const allowedRoles = new Set(["coffee_bean", "barista", "committee_member", "treasurer"]);

const FRIENDS_OF_323_PRODUCTION_URL = "https://friendsof323.netlify.app";

exports.handler = async function handler(event) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };

  if (event.httpMethod !== "POST") {
    return response(405, { error: "Method not allowed." }, headers);
  }

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return response(500, {
      error: "Supabase administration environment variables are not configured."
    }, headers);
  }

  try {
    const token = getBearerToken(event.headers.authorization || event.headers.Authorization);
    const caller = await verifyUser(token);
    const profile = await getProfile(caller.id);

    if (!profile?.is_active || profile.role !== "coffee_bean") {
      return response(403, { error: "Coffee Bean access is required." }, headers);
    }

    const body = JSON.parse(event.body || "{}");

    if (body.action === "list_users") {
      const users = await listAllUsers();
      const profiles = await listProfiles();
      const profileMap = new Map(profiles.map(item => [item.id, item]));

      return response(200, {
        // Only show accounts with an application profile. An Auth-only account is not a portal member.
        users: users.filter(authUser => profileMap.has(authUser.id)).map(authUser => {
          const appProfile = profileMap.get(authUser.id) || {};
          return {
            id: authUser.id,
            email: authUser.email,
            display_name: appProfile.display_name ||
              authUser.user_metadata?.display_name ||
              authUser.user_metadata?.full_name ||
              null,
            role: appProfile.role || "committee_member",
            is_active: appProfile.is_active !== false,
            receive_order_notifications:
              appProfile.receive_order_notifications === true,
            den_id: appProfile.den_id || null,
            created_at: authUser.created_at,
            last_sign_in_at: authUser.last_sign_in_at,
            invited_at: authUser.invited_at,
            email_confirmed_at: authUser.email_confirmed_at
          };
        })
      }, headers);
    }

    if (body.action === "invite_user") {
      const email = String(body.email || "").trim().toLowerCase();
      const displayName = String(body.display_name || "").trim();
      const role = String(body.role || "committee_member");
      const denId = body.den_id || null;

      if (!email || !email.includes("@")) {
        return response(400, { error: "A valid email address is required." }, headers);
      }
      if (!allowedRoles.has(role)) {
        return response(400, { error: "Invalid portal role." }, headers);
      }

      const redirectTo = `${FRIENDS_OF_323_PRODUCTION_URL}/committee/set-password.html`;
      const inviteResponse = await fetch(`${SUPABASE_URL}/auth/v1/invite?redirect_to=${encodeURIComponent(redirectTo)}`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          email,
          data: { display_name: displayName },
          redirect_to: redirectTo
        })
      });

      const inviteBody = await parseJson(inviteResponse);
      if (!inviteResponse.ok) {
        throw new Error(inviteBody.msg || inviteBody.message || inviteBody.error_description || "Invitation failed.");
      }

      const userId = inviteBody.id || inviteBody.user?.id;
      if (userId) {
        const updateResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${encodeURIComponent(userId)}`,
          {
            method: "PATCH",
            headers: {
              ...adminHeaders(),
              "Prefer": "return=minimal"
            },
            body: JSON.stringify({
              display_name: displayName || null,
              role,
              den_id: role === "barista" ? denId : null,
              is_active: true
            })
          }
        );
        if (!updateResponse.ok) {
          const updateBody = await parseJson(updateResponse);
          throw new Error(updateBody.message || "Invitation was sent, but the role could not be assigned.");
        }
      }

      return response(200, { success: true, user_id: userId }, headers);
    }


    if (body.action === "resend_invite") {
      const target = await getAuthUser(body.user_id);
      if (!target?.email) {
        return response(404, { error: "Portal user was not found." }, headers);
      }
      if (target.email_confirmed_at) {
        return response(400, {
          error: "This account has already accepted its invitation. Use Send Password Reset instead."
        }, headers);
      }

      const redirectTo = `${FRIENDS_OF_323_PRODUCTION_URL}/committee/set-password.html`;
      const inviteResponse = await fetch(`${SUPABASE_URL}/auth/v1/invite?redirect_to=${encodeURIComponent(redirectTo)}`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          email: target.email,
          data: target.user_metadata || {},
          redirect_to: redirectTo
        })
      });
      const inviteBody = await parseJson(inviteResponse);
      if (!inviteResponse.ok) {
        throw new Error(inviteBody.msg || inviteBody.message || inviteBody.error_description || "Invitation could not be resent.");
      }

      return response(200, { success: true }, headers);
    }

    if (body.action === "send_password_reset") {
      const target = await getAuthUser(body.user_id);
      if (!target?.email) {
        return response(404, { error: "Portal user was not found." }, headers);
      }
      if (!target.email_confirmed_at) {
        return response(400, {
          error: "This account has not accepted its invitation yet. Resend the invitation instead."
        }, headers);
      }

      const redirectTo = `${FRIENDS_OF_323_PRODUCTION_URL}/committee/reset-password.html`;
      const resetResponse = await fetch(`${SUPABASE_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          email: target.email,
          redirect_to: redirectTo
        })
      });
      const resetBody = await parseJson(resetResponse);
      if (!resetResponse.ok) {
        throw new Error(resetBody.msg || resetBody.message || resetBody.error_description || "Password reset email could not be sent.");
      }

      return response(200, { success: true }, headers);
    }

    return response(400, { error: "Unknown administration action." }, headers);
  } catch (error) {
    console.error("committee-admin error", error);
    return response(500, { error: error.message || "Administration request failed." }, headers);
  }
};

function getBearerToken(header) {
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Authentication token is missing.");
  return match[1];
}

async function verifyUser(token) {
  const result = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      "apikey": SUPABASE_SECRET_KEY,
      "Authorization": `Bearer ${token}`
    }
  });
  const body = await parseJson(result);
  if (!result.ok || !body.id) throw new Error("Your session is invalid or expired.");
  return body;
}

async function getProfile(userId) {
  const result = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${encodeURIComponent(userId)}&select=id,role,is_active`,
    { headers: adminHeaders() }
  );
  const body = await parseJson(result);
  if (!result.ok) throw new Error(body.message || "Unable to verify portal access.");
  return body[0] || null;
}

async function listProfiles() {
  const result = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?select=id,display_name,role,is_active,receive_order_notifications,den_id,created_at,updated_at`,
    { headers: adminHeaders() }
  );
  const body = await parseJson(result);
  if (!result.ok) throw new Error(body.message || "Unable to load portal profiles.");
  return body;
}


async function getAuthUser(userId) {
  const id = String(userId || "").trim();
  if (!id) throw new Error("A user ID is required.");

  const result = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`,
    { headers: adminHeaders() }
  );
  const body = await parseJson(result);
  if (!result.ok) {
    if (result.status === 404) return null;
    throw new Error(body.message || body.msg || "Unable to load authentication user.");
  }
  return body.user || body;
}

async function listAllUsers() {
  const all = [];
  let page = 1;

  while (true) {
    const result = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=100`,
      { headers: adminHeaders() }
    );
    const body = await parseJson(result);
    if (!result.ok) throw new Error(body.message || body.msg || "Unable to load authentication users.");

    const users = Array.isArray(body) ? body : (body.users || []);
    all.push(...users);
    if (users.length < 100) break;
    page += 1;
  }

  return all;
}

function adminHeaders() {
  return {
    "Content-Type": "application/json",
    "apikey": SUPABASE_SECRET_KEY,
    "Authorization": `Bearer ${SUPABASE_SECRET_KEY}`
  };
}

async function parseJson(result) {
  return result.json().catch(() => ({}));
}

function response(statusCode, body, headers) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body)
  };
}
