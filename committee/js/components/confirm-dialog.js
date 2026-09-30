let activeDialog = null;

function ensureDialog() {
  let dialog = document.querySelector("#portal-confirm-dialog");
  if (dialog) return dialog;

  dialog = document.createElement("dialog");
  dialog.id = "portal-confirm-dialog";
  dialog.className = "portal-dialog portal-confirm-dialog";
  dialog.innerHTML = `
    <form method="dialog" class="dialog-card portal-confirm-card">
      <div class="dialog-header portal-confirm-header">
        <h2 id="portal-confirm-title">Confirm action</h2>
        <button type="button" class="icon-button" data-confirm-close aria-label="Close">×</button>
      </div>
      <p id="portal-confirm-message" class="portal-confirm-message"></p>
      <div class="dialog-actions">
        <button type="button" class="portal-button portal-button--secondary" data-confirm-cancel>Cancel</button>
        <button type="button" class="portal-button" data-confirm-ok>Confirm</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  return dialog;
}

export function confirmAction({
  title = "Confirm action",
  message = "Are you sure?",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  urgent = false
} = {}) {
  const dialog = ensureDialog();
  if (activeDialog && dialog.open) dialog.close();

  const titleEl = dialog.querySelector("#portal-confirm-title");
  const messageEl = dialog.querySelector("#portal-confirm-message");
  const okButton = dialog.querySelector("[data-confirm-ok]");
  const cancelButton = dialog.querySelector("[data-confirm-cancel]");
  const closeButton = dialog.querySelector("[data-confirm-close]");

  titleEl.textContent = title;
  messageEl.textContent = message;
  okButton.textContent = confirmLabel;
  cancelButton.textContent = cancelLabel;
  okButton.classList.toggle("portal-button--urgent", urgent);
  dialog.classList.toggle("portal-confirm-dialog--urgent", urgent);

  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      activeDialog = null;
      cleanup();
      if (dialog.open) dialog.close();
      resolve(result);
    };
    const onCancel = event => { event.preventDefault(); finish(false); };
    const onClose = () => finish(false);
    const cleanup = () => {
      okButton.removeEventListener("click", onOk);
      cancelButton.removeEventListener("click", onCancelClick);
      closeButton.removeEventListener("click", onCancelClick);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("close", onClose);
    };
    const onOk = () => finish(true);
    const onCancelClick = () => finish(false);

    okButton.addEventListener("click", onOk);
    cancelButton.addEventListener("click", onCancelClick);
    closeButton.addEventListener("click", onCancelClick);
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("close", onClose);

    activeDialog = { finish };
    dialog.showModal();
    setTimeout(() => okButton.focus(), 0);
  });
}
