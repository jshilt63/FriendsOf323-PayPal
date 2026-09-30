const CART_STORAGE_KEY = "friendsOf323StorefrontCart";
const CHECKOUT_STORAGE_KEY = "friendsOf323CheckoutDraft";
const PENDING_ORDER_STORAGE_KEY = "friendsOf323PendingOrder";

function loadPendingOrder() {
    try {
        const raw = localStorage.getItem(PENDING_ORDER_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function clearCompletedCheckout() {
    localStorage.removeItem(CART_STORAGE_KEY);
    localStorage.removeItem(CHECKOUT_STORAGE_KEY);
    localStorage.removeItem(PENDING_ORDER_STORAGE_KEY);
}

function showOrderNumber(pendingOrder) {
    const container = document.querySelector("#success-order-number");

    if (!container || !pendingOrder?.store_order_number) {
        return;
    }

    container.textContent = `Friends of 323 Order #${pendingOrder.store_order_number}`;
    container.hidden = false;
}

document.addEventListener("DOMContentLoaded", () => {
    // Read the customer-facing order number before clearing the
    // completed checkout information from this browser.
    const pendingOrder = loadPendingOrder();

    showOrderNumber(pendingOrder);

    // This script runs only on Stripe's successful return page.
    // A cancelled checkout never reaches this page, so its cart
    // and checkout draft remain available for another attempt.
    clearCompletedCheckout();
});
