import { AdministrationService } from "../services/administration-service.js?v=1.9.6";
import { setFormBusy, setNotice } from "../master-data/shared.js";

export function storeNoticePanelMarkup() {
  return `
    <section id="store-notice-panel" class="admin-panel" hidden>
      <div class="store-notice-card">
        <div class="store-notice-card__heading">
          <div>
            <h2 class="admin-section-title">Store Notice</h2>
            <p class="cell-note">When enabled, customers see a banner on the store and a one-time entrance notice during each browser session.</p>
          </div>
          <label class="shipping-enable-toggle">
            <input id="store-notice-enabled" type="checkbox">
            <span>Enable store notice</span>
          </label>
        </div>
        <div id="store-notice-status" class="shipping-setting-status" aria-live="polite"></div>

        <form id="store-notice-form" class="portal-form">
          <div class="form-grid">
            <label class="form-field form-field--full">
              <span>Notice heading</span>
              <input name="announcement_title" maxlength="140" required>
            </label>
            <label class="form-field form-field--full">
              <span>Notice message</span>
              <textarea name="announcement_message" rows="7" maxlength="1200" required></textarea>
            </label>
          </div>
          <div class="store-notice-preview" aria-label="Store notice preview">
            <span>Coffee Operations Notice</span>
            <strong id="store-notice-preview-title"></strong>
            <p id="store-notice-preview-message"></p>
          </div>
          <div class="dialog-actions">
            <button class="portal-button" type="submit">Save Notice</button>
          </div>
        </form>
      </div>
    </section>`;
}

export function initializeStoreNoticeAdmin({ notice }) {
  const form = document.querySelector("#store-notice-form");
  const enabled = document.querySelector("#store-notice-enabled");
  const status = document.querySelector("#store-notice-status");
  const previewTitle = document.querySelector("#store-notice-preview-title");
  const previewMessage = document.querySelector("#store-notice-preview-message");
  let settings = {};

  const preview = () => {
    previewTitle.textContent = form.elements.announcement_title.value || "Notice heading";
    previewMessage.textContent = form.elements.announcement_message.value || "Notice message";
  };

  const render = () => {
    enabled.checked = Boolean(settings.announcement_enabled);
    form.elements.announcement_title.value = settings.announcement_title || "Our Bean Acquisition Clerk Is On Vacation";
    form.elements.announcement_message.value = settings.announcement_message || "";
    status.className = `shipping-setting-status ${settings.announcement_enabled ? "is-enabled" : "is-disabled"}`;
    status.textContent = settings.announcement_enabled
      ? "The store notice is live. Customers will see the banner and entrance notice."
      : "The store notice is currently hidden from customers.";
    preview();
  };

  async function load() {
    settings = await AdministrationService.getStoreNoticeSettings();
    render();
  }

  enabled.addEventListener("change", async () => {
    const next = enabled.checked;
    enabled.disabled = true;
    status.className = "shipping-setting-status";
    status.textContent = "Saving store notice setting…";
    try {
      settings = await AdministrationService.saveStoreNoticeSettings({ announcement_enabled:next });
      render();
      setNotice(notice, next ? "Store notice enabled." : "Store notice disabled.", "success");
    } catch (error) {
      enabled.checked = !next;
      setNotice(notice, error.message, "error");
      render();
    } finally {
      enabled.disabled = false;
    }
  });

  form.addEventListener("input", preview);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    setFormBusy(form, true, "Saving notice…");
    try {
      settings = await AdministrationService.saveStoreNoticeSettings({
        announcement_title:String(form.elements.announcement_title.value || "").trim(),
        announcement_message:String(form.elements.announcement_message.value || "").trim()
      });
      render();
      setNotice(notice, "Store notice saved.", "success");
    } catch (error) {
      setNotice(notice, error.message, "error");
    } finally {
      setFormBusy(form, false);
    }
  });

  return { load };
}
