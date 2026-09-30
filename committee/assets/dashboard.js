import { requirePortalUser, showMessage, signOut } from "./auth-common.js";

const ROLE_LABELS = {
  coffee_bean: "Coffee Bean",
  barista: "Barista",
  committee_member: "Committee Member"
};

const welcome = document.querySelector("#welcome-text");
const roleBadge = document.querySelector("#role-badge");
const message = document.querySelector("#dashboard-message");
const signOutButton = document.querySelector("#sign-out-button");

const result = await requirePortalUser();

if (result) {
  welcome.textContent = `Signed in as ${result.profile.display_name || result.user.email}.`;
  roleBadge.textContent = ROLE_LABELS[result.profile.role] || result.profile.role;
  roleBadge.hidden = false;
} else {
  showMessage(message, "Unable to load your portal account.", "error");
}

signOutButton.addEventListener("click", signOut);
