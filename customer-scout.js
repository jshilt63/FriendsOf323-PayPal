const CART_STORAGE_KEY = "friendsOf323StorefrontCart";
const CHECKOUT_STORAGE_KEY = "friendsOf323CheckoutDraft";
const SCOUT_FEED_URL = "/.netlify/functions/store-scouts";
const PAYPAL_CREATE_ORDER_URL = "/.netlify/functions/paypal-create-order";
const SHIPPING_RATES_URL = "/.netlify/functions/store-shipping-rates";
const PAYMENT_METHOD_ONLINE = "online";
const PAYMENT_METHOD_CASH = "cash";
const FULFILLMENT_PICKUP = "pickup";
const FULFILLMENT_LOCAL_DELIVERY = "local_delivery";
const FULFILLMENT_SHIPPING = "shipping";

let cart = [];
let scouts = [];
let selectedScoutIds = new Set();
let allocations = {};
let shippingRates = [];
let shippingRatesLoaded = false;
let shippingEnabled = false;
let shippingQuote = null;
let shippingQuoteLoading = false;
let shippingQuoteTimer = null;


function formatPhoneNumber(value) {
  const raw = String(value || "").trim();
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  if (!digits) return "";
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)})${digits.slice(3)}`;
  return `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function normalizePhoneNumber(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.slice(0, 10);
}

function money(value) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD"
    }).format(Number(value || 0));
}

function grindLabel(value) {
    return value === "whole_bean" ? "Whole Bean" : "Ground";
}

function cartKey(item, index) {
    return item.type === "product"
        ? `${item.productId}|${item.grind}|${index}`
        : `processing|${index}`;
}

function loadCart() {
    try {
        const raw = localStorage.getItem(CART_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function loadDraft() {
    try {
        const raw = localStorage.getItem(CHECKOUT_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function saveDraft() {
    const form = document.querySelector("#customer-scout-form");
    if (!form) return;

    const data = Object.fromEntries(new FormData(form).entries());

    localStorage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify({
        customer: data,
        selectedScoutIds: Array.from(selectedScoutIds),
        allocations
    }));
}

function cartTotal() {
    return cart.reduce((sum, item) => sum + Number(item.unitPrice) * Number(item.quantity), 0);
}

function coffeeBagCount() {
    return cart
        .filter(item => item.type === "product")
        .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
}

function matchingShippingRate() {
    const bags = coffeeBagCount();
    return shippingRates.find(rate =>
        bags >= Number(rate.min_bags) &&
        (rate.max_bags == null || bags <= Number(rate.max_bags))
    ) || null;
}

function selectedShippingAmount() {
    if (selectedFulfillmentMethod() !== FULFILLMENT_SHIPPING) return 0;
    return Number(shippingQuote?.amount || 0);
}

function checkoutGrandTotal() {
    return cartTotal() + selectedShippingAmount();
}

function shippingQuoteItems() {
    return cart
        .filter(item => item.type === "product")
        .map(item => ({ product_id:item.productId, quantity:Number(item.quantity || 0) }))
        .filter(item => item.product_id && item.quantity > 0);
}

function shippingDestination() {
    const form = document.querySelector("#customer-scout-form");
    if (!form) return {};
    const data = new FormData(form);
    return {
        name:[data.get("first_name"), data.get("last_name")].filter(Boolean).join(" ").trim(),
        address_line_1:String(data.get("address_line_1") || "").trim(),
        address_line_2:String(data.get("address_line_2") || "").trim(),
        city:String(data.get("city") || "").trim(),
        state:String(data.get("state") || "").trim(),
        postal_code:String(data.get("postal_code") || "").trim()
    };
}

function shippingAddressReady() {
    const destination = shippingDestination();
    return Boolean(destination.address_line_1 && destination.city && destination.state && /^\d{5}(?:-\d{4})?$/.test(destination.postal_code));
}

function updateShippingDescription(message = "") {
    const description = document.querySelector("#shipping-option-description");
    if (description && message) description.textContent = message;
}

async function refreshShippingQuote({ silent = false } = {}) {
    const shippingInput = document.querySelector('input[name="fulfillment_method"][value="shipping"]');
    const shippingChoice = shippingInput?.closest(".payment-choice");
    if (!shippingEnabled) return null;

    const packageRate = matchingShippingRate();
    if (!packageRate) {
        shippingQuote = null;
        if (shippingInput) shippingInput.disabled = true;
        updateShippingDescription(`Shipping is not configured for ${coffeeBagCount()} ${coffeeBagCount() === 1 ? "bag" : "bags"}. Please choose pickup or local delivery.`);
        renderCartReview();
        updateContinueState();
        return null;
    }

    if (shippingChoice) shippingChoice.hidden = false;
    if (shippingInput) shippingInput.disabled = false;

    if (!shippingAddressReady()) {
        shippingQuote = null;
        updateShippingDescription("Enter your complete shipping address to calculate USPS Ground Advantage shipping.");
        renderCartReview();
        updateContinueState();
        return null;
    }

    shippingQuoteLoading = true;
    if (!silent) updateShippingDescription("Calculating USPS Ground Advantage shipping…");
    updateContinueState();
    try {
        const response = await fetch(SHIPPING_RATES_URL, {
            method:"POST",
            headers:{ "Content-Type":"application/json", Accept:"application/json" },
            cache:"no-store",
            body:JSON.stringify({ destination:shippingDestination(), items:shippingQuoteItems() })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !Number.isFinite(Number(data.amount))) throw new Error(data.error || "Shipping could not be calculated.");
        shippingQuote = data;
        const sourceNote = data.source === "fallback" ? " (fallback rate)" : "";
        updateShippingDescription(`${data.label}: ${money(data.amount)} for ${data.bag_count} ${Number(data.bag_count) === 1 ? "bag" : "bags"}${sourceNote}.`);
        return data;
    } catch (error) {
        shippingQuote = null;
        updateShippingDescription(error.message || "Shipping is temporarily unavailable. Please choose pickup or local delivery.");
        if (!silent) console.error("Unable to calculate shipping:", error);
        return null;
    } finally {
        shippingQuoteLoading = false;
        renderCartReview();
        updateContinueState();
    }
}

function scheduleShippingQuote() {
    clearTimeout(shippingQuoteTimer);
    shippingQuoteTimer = setTimeout(() => {
        if (selectedFulfillmentMethod() === FULFILLMENT_SHIPPING) refreshShippingQuote({ silent:true });
    }, 450);
}

async function loadShippingRates() {
    const shippingInput = document.querySelector('input[name="fulfillment_method"][value="shipping"]');
    const shippingChoice = shippingInput?.closest(".payment-choice");
    try {
        const response = await fetch(SHIPPING_RATES_URL, { headers:{ Accept:"application/json" }, cache:"no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(data.rates)) throw new Error(data.error || "Shipping rates unavailable.");
        shippingEnabled = Boolean(data.enabled);
        shippingRates = shippingEnabled ? data.rates : [];
        shippingRatesLoaded = true;
        const rate = matchingShippingRate();
        if (shippingChoice) shippingChoice.hidden = !shippingEnabled;
        if (shippingInput) {
            shippingInput.disabled = !shippingEnabled || !rate;
            if (shippingInput.checked && shippingInput.disabled) shippingInput.checked = false;
        }
        if (!shippingEnabled) {
            updateShippingDescription("Shipping is currently unavailable. Please choose pickup or local delivery.");
        } else if (!rate) {
            updateShippingDescription(`Shipping is not configured for ${coffeeBagCount()} ${coffeeBagCount() === 1 ? "bag" : "bags"}. Please choose pickup or local delivery.`);
        } else {
            updateShippingDescription("Enter your shipping address to calculate USPS Ground Advantage shipping.");
        }
    } catch (error) {
        shippingRatesLoaded = true;
        shippingEnabled = false;
        shippingRates = [];
        shippingQuote = null;
        if (shippingChoice) shippingChoice.hidden = true;
        if (shippingInput) shippingInput.disabled = true;
        updateShippingDescription("Shipping is temporarily unavailable. Please choose pickup or local delivery.");
        console.error("Unable to load shipping rates:", error);
    }
    renderCartReview();
    updateContinueState();
}

function initializeMenu() {
    const button = document.querySelector(".menu-button");
    const navigation = document.querySelector(".main-nav");
    if (!button || !navigation) return;

    button.addEventListener("click", () => {
        const open = navigation.classList.toggle("is-open");
        button.setAttribute("aria-expanded", String(open));
    });

    navigation.addEventListener("click", event => {
        if (event.target.matches("a")) {
            navigation.classList.remove("is-open");
            button.setAttribute("aria-expanded", "false");
        }
    });
}

function renderCartReview() {
    const container = document.querySelector("#checkout-cart-items");
    const total = document.querySelector("#checkout-total");
    container.innerHTML = "";

    cart.forEach(item => {
        const row = document.createElement("div");
        row.className = "checkout-cart-item";

        const details = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = item.productName;

        const meta = document.createElement("span");
        if (item.type === "product") {
            meta.textContent = `${item.bagSize} • ${grindLabel(item.grind)} • Qty ${item.quantity}`;
        } else {
            meta.textContent = `Qty ${item.quantity}`;
        }
        details.append(name, meta);

        const line = document.createElement("strong");
        line.textContent = money(Number(item.unitPrice) * Number(item.quantity));

        row.append(details, line);
        container.appendChild(row);
    });

    if (selectedFulfillmentMethod() === FULFILLMENT_SHIPPING && shippingQuote) {
        const row = document.createElement("div");
        row.className = "checkout-cart-item checkout-cart-item--shipping";
        const details = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = "Shipping";
        const meta = document.createElement("span");
        meta.textContent = shippingQuote.label || "USPS Ground Advantage";
        details.append(name, meta);
        const amount = document.createElement("strong");
        amount.textContent = money(selectedShippingAmount());
        row.append(details, amount);
        container.appendChild(row);
    }

    total.textContent = money(checkoutGrandTotal());
}

function restoreCustomerDraft(draft) {
    if (!draft?.customer) return;

    Object.entries(draft.customer).forEach(([name, value]) => {
        const field = document.querySelector(`[name="${CSS.escape(name)}"]`);
        if (!field || typeof value !== "string") return;
        if (field.type === "radio") {
            const option = document.querySelector(`[name="${CSS.escape(name)}"][value="${CSS.escape(value)}"]`);
            if (option) option.checked = true;
        } else {
            field.value = value;
        }
    });
}

async function loadScouts() {
    const status = document.querySelector("#scout-status");
    const picker = document.querySelector("#scout-picker");

    try {
        const response = await fetch(SCOUT_FEED_URL, {
            headers: { Accept: "application/json" },
            cache: "no-store"
        });

        if (!response.ok) throw new Error(`Scout feed returned ${response.status}`);

        const data = await response.json();
        if (!Array.isArray(data.scouts)) throw new Error("Scout feed did not return a scouts array.");

        scouts = data.scouts;
        renderScoutPicker();
        status.hidden = true;
        picker.hidden = false;
    } catch (error) {
        console.error("Unable to load Scouts:", error);
        status.classList.add("scout-status--error");
        status.textContent = "Unable to load the Scout list. Please refresh the page.";
    }
}

function scoutDisplayName(scout) {
    if (scout.is_general_fund) return "Pack 323 General Fund";
    return [scout.first_name, scout.last_name].filter(Boolean).join(" ");
}

function scoutMeta(scout) {
    if (scout.is_general_fund) return "Use this if no individual Scout should receive credit.";
    const parts = [];
    if (scout.den_number) parts.push(`Den ${scout.den_number}`);
    if (scout.rank) parts.push(scout.rank);
    return parts.join(" • ");
}

function normalizedScoutSearchText(scout) {
    return [
        scout.first_name,
        scout.last_name,
        `${scout.first_name || ""} ${scout.last_name || ""}`,
        `${scout.last_name || ""} ${scout.first_name || ""}`
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
}

function setScoutSelected(scoutId, selected) {
    if (selected) selectedScoutIds.add(scoutId);
    else selectedScoutIds.delete(scoutId);

    normalizeAllocations();
    renderScoutPicker();
    renderAllocations();
    updateContinueState();
    saveDraft();
}

function renderSelectedScoutChips() {
    const container = document.querySelector("#selected-scouts");
    container.innerHTML = "";

    const selected = scouts.filter(scout => selectedScoutIds.has(scout.id));

    if (!selected.length) {
        const empty = document.createElement("span");
        empty.className = "selected-scouts__empty";
        empty.textContent = "No Scouts selected yet.";
        container.appendChild(empty);
        return;
    }

    selected.forEach(scout => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "selected-scout-chip";
        chip.setAttribute("aria-label", `Remove ${scoutDisplayName(scout)}`);
        chip.innerHTML = `<span>${escapeHtml(scoutDisplayName(scout))}</span><span aria-hidden="true">×</span>`;
        chip.addEventListener("click", () => setScoutSelected(scout.id, false));
        container.appendChild(chip);
    });
}

function createScoutResultButton(scout) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "scout-result";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", selectedScoutIds.has(scout.id) ? "true" : "false");

    const copy = document.createElement("span");
    copy.className = "scout-result__copy";

    const name = document.createElement("strong");
    name.textContent = scoutDisplayName(scout);

    const meta = document.createElement("span");
    meta.textContent = scoutMeta(scout);

    copy.append(name, meta);

    const state = document.createElement("span");
    state.className = "scout-result__state";
    state.textContent = selectedScoutIds.has(scout.id) ? "Selected ✓" : "Select";

    button.append(copy, state);

    button.addEventListener("click", () => {
        setScoutSelected(scout.id, !selectedScoutIds.has(scout.id));
    });

    return button;
}

function renderGeneralFund() {
    const container = document.querySelector("#general-fund-option");
    container.innerHTML = "";

    const generalFund = scouts.find(scout => scout.is_general_fund);
    if (!generalFund) return;

    const button = createScoutResultButton(generalFund);
    button.classList.add("scout-result--general-fund");
    container.appendChild(button);
}

function renderScoutResults() {
    const input = document.querySelector("#scout-search-input");
    const results = document.querySelector("#scout-results");
    const note = document.querySelector("#scout-results-note");

    const query = String(input?.value || "").trim().toLowerCase();

    const individualScouts = scouts.filter(scout => !scout.is_general_fund);

    let matches;
    if (!query) {
        matches = individualScouts.slice(0, 6);
    } else {
        matches = individualScouts
            .filter(scout => normalizedScoutSearchText(scout).includes(query))
            .slice(0, 8);
    }

    results.innerHTML = "";

    matches.forEach(scout => {
        results.appendChild(createScoutResultButton(scout));
    });

    if (!query) {
        note.textContent = individualScouts.length > matches.length
            ? "Showing the first 6 Scouts. Search by first or last name to narrow the list."
            : "";
    } else if (!matches.length) {
        note.textContent = "No Scouts match that name.";
    } else {
        note.textContent = `${matches.length} ${matches.length === 1 ? "match" : "matches"} shown.`;
    }
}

function renderScoutPicker() {
    renderSelectedScoutChips();
    renderGeneralFund();
    renderScoutResults();
    renderAllocations();
    updateContinueState();
}
function productCartItems() {
    return cart
        .map((item, index) => ({ item, index, key: cartKey(item, index) }))
        .filter(entry => entry.item.type === "product");
}

function normalizeAllocations() {
    const validScouts = selectedScoutIds;

    productCartItems().forEach(({ item, key }) => {
        if (!allocations[key]) allocations[key] = {};

        Object.keys(allocations[key]).forEach(scoutId => {
            if (!validScouts.has(scoutId)) delete allocations[key][scoutId];
        });

        let assigned = Object.values(allocations[key]).reduce((sum, value) => sum + Number(value || 0), 0);

        if (selectedScoutIds.size === 1) {
            const onlyScout = Array.from(selectedScoutIds)[0];
            allocations[key] = { [onlyScout]: Number(item.quantity) };
            return;
        }

        if (assigned > Number(item.quantity)) {
            allocations[key] = {};
        }
    });
}

function evenSplit(quantity, scoutIds) {
    const result = {};
    if (!scoutIds.length) return result;

    const base = Math.floor(quantity / scoutIds.length);
    let remainder = quantity % scoutIds.length;

    scoutIds.forEach(id => {
        result[id] = base + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
    });

    return result;
}

function splitAllEvenly() {
    const ids = Array.from(selectedScoutIds);
    if (!ids.length) return;

    productCartItems().forEach(({ item, key }) => {
        allocations[key] = evenSplit(Number(item.quantity), ids);
    });

    renderAllocations();
    updateContinueState();
    saveDraft();
}

function assignedQuantity(key) {
    return Object.values(allocations[key] || {})
        .reduce((sum, value) => sum + Number(value || 0), 0);
}

function allocationIsComplete() {
    if (!selectedScoutIds.size) return false;

    return productCartItems().every(({ item, key }) =>
        assignedQuantity(key) === Number(item.quantity)
    );
}

function renderAllocations() {
    const panel = document.querySelector("#allocation-panel");
    const list = document.querySelector("#allocation-list");
    const status = document.querySelector("#allocation-status");

    if (!selectedScoutIds.size) {
        panel.hidden = true;
        list.innerHTML = "";
        status.textContent = "";
        return;
    }

    panel.hidden = false;
    list.innerHTML = "";

    const selectedScouts = scouts.filter(scout => selectedScoutIds.has(scout.id));

    productCartItems().forEach(({ item, key }) => {
        if (!allocations[key]) allocations[key] = {};

        if (selectedScouts.length === 1) {
            allocations[key] = { [selectedScouts[0].id]: Number(item.quantity) };
        }

        const block = document.createElement("div");
        block.className = "allocation-item";

        const heading = document.createElement("div");
        heading.className = "allocation-item__heading";

        const titleWrap = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = item.productName;

        const meta = document.createElement("span");
        meta.textContent = `${item.bagSize} • ${grindLabel(item.grind)} • ${item.quantity} ${item.quantity === 1 ? "bag" : "bags"}`;

        titleWrap.append(title, meta);

        const count = document.createElement("span");
        count.className = "allocation-item__count";

        heading.append(titleWrap, count);

        const rows = document.createElement("div");
        rows.className = "allocation-item__rows";

        selectedScouts.forEach(scout => {
            const row = document.createElement("label");
            row.className = "allocation-row";

            const name = document.createElement("span");
            name.textContent = scoutDisplayName(scout);

            const input = document.createElement("input");
            input.type = "number";
            input.min = "0";
            input.max = String(item.quantity);
            input.step = "1";
            input.inputMode = "numeric";
            input.value = String(allocations[key][scout.id] || 0);
            input.disabled = selectedScouts.length === 1;
            input.setAttribute("aria-label", `${item.productName} bags assigned to ${scoutDisplayName(scout)}`);

            input.addEventListener("input", () => {
                const value = Math.max(0, Math.min(Number(item.quantity), Number(input.value || 0)));
                allocations[key][scout.id] = value;
                updateAllocationCount(key, Number(item.quantity), count, block);
                updateContinueState();
                saveDraft();
            });

            row.append(name, input);
            rows.appendChild(row);
        });

        block.append(heading, rows);
        list.appendChild(block);

        updateAllocationCount(key, Number(item.quantity), count, block);
    });

    status.textContent = allocationIsComplete()
        ? "All coffee bags assigned ✓"
        : "Assign every coffee bag before continuing.";
}

function updateAllocationCount(key, required, countElement, block) {
    const assigned = assignedQuantity(key);
    countElement.textContent = `${assigned} of ${required} assigned`;

    const valid = assigned === required;
    block.classList.toggle("allocation-item--complete", valid);
    block.classList.toggle("allocation-item--incomplete", !valid);
}

function selectedFulfillmentMethod() {
    return document.querySelector('input[name="fulfillment_method"]:checked')?.value || "";
}

function fulfillmentLabel(value) {
    if (value === FULFILLMENT_PICKUP) return "Pickup / No Delivery Needed";
    if (value === FULFILLMENT_LOCAL_DELIVERY) return "Local Delivery";
    if (value === FULFILLMENT_SHIPPING) return "Shipping";
    return "Not selected";
}

function customerFormIsValid() {
    const required = [
        "#first-name",
        "#last-name",
        "#email",
        "#address-1",
        "#city",
        "#state",
        "#postal-code"
    ];

    const customerValid = required.every(selector => {
        const field = document.querySelector(selector);
        return field && field.checkValidity();
    });

    const fulfillment = selectedFulfillmentMethod();
    const shippingValid = fulfillment !== FULFILLMENT_SHIPPING || (shippingRatesLoaded && shippingEnabled && Boolean(matchingShippingRate()));
    return customerValid && Boolean(fulfillment) && shippingValid;
}

function updateContinueState() {
    const button = document.querySelector("#continue-review");
    const shippingReady = selectedFulfillmentMethod() !== FULFILLMENT_SHIPPING
        || (shippingEnabled && !shippingQuoteLoading && Boolean(shippingQuote));
    button.disabled = !(customerFormIsValid() && allocationIsComplete() && shippingReady);
}


function selectedPaymentMethod() {
    if (selectedFulfillmentMethod() === FULFILLMENT_SHIPPING) return PAYMENT_METHOD_ONLINE;
    return document.querySelector('input[name="store_payment_method"]:checked')?.value
        || PAYMENT_METHOD_ONLINE;
}

function removeProcessingSupportForCash() {
    const before = cart.length;
    cart = cart.filter(item => item.type !== "processing");

    if (cart.length !== before) {
        localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
        renderCartReview();
    }
}

function syncPaymentMethodUi() {
    const method = selectedPaymentMethod();
    const paymentButton = document.querySelector("#continue-to-payment");
    const cashNote = document.querySelector("#cash-payment-note");
    const processingNote = document.querySelector("#cash-processing-note");

    if (method === PAYMENT_METHOD_CASH) {
        const hadProcessing = cart.some(item => item.type === "processing");
        removeProcessingSupportForCash();

        if (processingNote) {
            processingNote.hidden = !hadProcessing;
        }

        if (cashNote) cashNote.hidden = false;

        if (paymentButton) {
            paymentButton.textContent = "Place Cash Order";
        }
    } else {
        if (cashNote) cashNote.hidden = true;
        if (processingNote) processingNote.hidden = true;

        if (paymentButton) {
            paymentButton.textContent = "Continue to Secure Payment";
        }
    }

    buildReview();
}


function checkoutProcessingSupportAmount() {
    const subtotal = cart.filter(item => item.type === "product")
        .reduce((sum, item) => sum + Number(item.unitPrice) * Number(item.quantity), 0);
    if (subtotal <= 0) return 0;
    return Math.ceil((((subtotal * 0.0349) + 0.49) / (1 - 0.0349)) * 100) / 100;
}

function setCheckoutProcessingSupport(included) {
    cart = cart.filter(item => item.type !== "processing");
    const amount = checkoutProcessingSupportAmount();
    if (included && selectedPaymentMethod() === PAYMENT_METHOD_ONLINE && amount > 0) {
        cart.push({type: "processing", productId: null, sku: "PROCESSING",
            productName: "Processing Cost Support", bagSize: null, grind: null,
            unitPrice: amount, quantity: 1});
    }
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    renderCartReview();
    buildReview();
}

function buildReview() {
    const form = document.querySelector("#customer-scout-form");
    const customer = Object.fromEntries(new FormData(form).entries());
    const review = document.querySelector("#final-review-content");

    const scoutMap = Object.fromEntries(
        scouts.map(scout => [scout.id, scoutDisplayName(scout)])
    );

    const productRows = productCartItems().map(({ item, key }) => {
        const assignments = Object.entries(allocations[key] || {})
            .filter(([, qty]) => Number(qty) > 0)
            .map(([scoutId, qty]) => `
                <li>
                    <span>${escapeHtml(scoutMap[scoutId] || "Scout")}</span>
                    <strong>${Number(qty)} ${Number(qty) === 1 ? "bag" : "bags"}</strong>
                </li>
            `)
            .join("");

        const lineTotal = Number(item.unitPrice) * Number(item.quantity);

        return `
            <article class="final-review-item">
                <div class="final-review-item__top">
                    <div class="final-review-item__product">
                        <strong>${escapeHtml(item.productName)}</strong>
                        <span>${escapeHtml(item.bagSize)} • ${escapeHtml(grindLabel(item.grind))}</span>
                    </div>

                    <div class="final-review-item__numbers">
                        <span>Qty ${Number(item.quantity)}</span>
                        <strong>${money(lineTotal)}</strong>
                    </div>
                </div>

                <div class="final-review-item__allocation">
                    <span class="final-review-item__allocation-label">Fundraising credit</span>
                    <ul>${assignments}</ul>
                </div>
            </article>
        `;
    }).join("");

    const processingRows = cart
        .filter(item => item.type === "processing")
        .map(item => `
            <article class="final-review-item final-review-item--processing">
                <div class="final-review-item__top">
                    <div class="final-review-item__product">
                        <strong>${escapeHtml(item.productName)}</strong>
                        <span>Optional processing-cost support</span>
                    </div>
                    <div class="final-review-item__numbers">
                        <span>Qty ${Number(item.quantity)}</span>
                        <strong>${money(Number(item.unitPrice) * Number(item.quantity))}</strong>
                    </div>
                </div>
            </article>
        `)
        .join("");

    review.innerHTML = `
        <section class="final-review-section">
            <div class="final-review-section__heading">
                <h3>Customer</h3>
            </div>

            <div class="final-review-customer">
                <div>
                    <strong>${escapeHtml(customer.first_name)} ${escapeHtml(customer.last_name)}</strong>
                    <span>${escapeHtml(customer.email)}</span>
                    ${customer.phone ? `<span>${escapeHtml(formatPhoneNumber(customer.phone))}</span>` : ""}
                </div>

                <address>
                    ${escapeHtml(customer.address_line_1)}
                    ${customer.address_line_2 ? `<br>${escapeHtml(customer.address_line_2)}` : ""}
                    <br>${escapeHtml(customer.city)}, ${escapeHtml(customer.state)} ${escapeHtml(customer.postal_code)}
                </address>
            </div>
        </section>

        <section class="final-review-section">
            <div class="final-review-section__heading">
                <h3>Fulfillment</h3>
            </div>
            <div class="final-review-customer">
                <div>
                    <strong>${escapeHtml(fulfillmentLabel(selectedFulfillmentMethod()))}</strong>
                    <span>${selectedFulfillmentMethod() === FULFILLMENT_PICKUP
                        ? "No delivery-area check is required."
                        : selectedFulfillmentMethod() === FULFILLMENT_LOCAL_DELIVERY
                            ? "Your address will be checked against Friends of 323 local delivery areas."
                            : `Shipping charge: ${money(selectedShippingAmount())} (${escapeHtml(matchingShippingRate()?.label || "configured rate")}).`}</span>
                </div>
            </div>
        </section>

        <section class="final-review-section">
            <div class="final-review-section__heading">
                <h3>Order &amp; Fundraising Credit</h3>
            </div>

            <div class="final-review-items">
                ${productRows}
                ${processingRows}
            </div>
        </section>

        <section class="final-review-section final-review-payment">
            <div class="final-review-section__heading">
                <h3>Payment Method</h3>
            </div>

            <div class="payment-choice-grid">
                <label class="payment-choice">
                    <input
                        type="radio"
                        name="store_payment_method"
                        value="${PAYMENT_METHOD_ONLINE}"
                        ${selectedPaymentMethod() === PAYMENT_METHOD_ONLINE ? "checked" : ""}
                    >
                    <span class="payment-choice__copy">
                        <strong>Pay Online</strong>
                        <span>Continue to PayPal to approve your payment.</span>
                    </span>
                </label>

                <label class="payment-choice">
                    <input
                        type="radio"
                        name="store_payment_method"
                        value="${PAYMENT_METHOD_CASH}"
                        ${selectedPaymentMethod() === PAYMENT_METHOD_CASH ? "checked" : ""}
                        ${selectedFulfillmentMethod() === FULFILLMENT_SHIPPING ? "disabled" : ""}
                    >
                    <span class="payment-choice__copy">
                        <strong>Pay Cash to Parent / Den Leader</strong>
                        <span>${selectedFulfillmentMethod() === FULFILLMENT_SHIPPING
                            ? "Shipping orders must be paid online so the shipping charge is collected with the order."
                            : "Give payment to the Scout's parent or your Den Leader."}</span>
                    </span>
                </label>
            </div>

            ${selectedPaymentMethod() === PAYMENT_METHOD_ONLINE ? `
            <div class="checkout-processing-support">
                <h4>Help your coffee purchase go further</h4>
                <label class="checkout-processing-support__choice">
                    <input type="checkbox" id="checkout-processing-support"
                        ${cart.some(item => item.type === "processing") ? "checked" : ""}
                        aria-describedby="checkout-processing-support-note">
                    <span><strong>Yes, add ${money(checkoutProcessingSupportAmount())} to help cover processing costs</strong></span>
                </label>
                <p id="checkout-processing-support-note">Optional. Your support helps more of your coffee purchase benefit Pack 323. This is an estimate of online processing costs, including processing on this extra amount.</p>
            </div>` : ""}

            <p id="cash-payment-note" class="payment-method-note" ${selectedPaymentMethod() === PAYMENT_METHOD_CASH ? "" : "hidden"}>
                Your order will be recorded as awaiting payment until the cash is received and marked paid in the Friends of 323 portal.
            </p>

            <p id="cash-processing-note" class="payment-method-note payment-method-note--highlight" hidden>
                Processing Cost Support was removed because there is no card-processing cost for a cash order.
            </p>
        </section>

        ${selectedFulfillmentMethod() === FULFILLMENT_SHIPPING ? `
        <div class="final-review__grand-total final-review__shipping-total">
            <span>Shipping</span>
            <strong>${money(selectedShippingAmount())}</strong>
        </div>` : ""}
        <div class="final-review__grand-total">
            <span>Order Total</span>
            <strong>${money(checkoutGrandTotal())}</strong>
        </div>
    `;

    review.querySelector("#checkout-processing-support")?.addEventListener("change", event => {
        setCheckoutProcessingSupport(event.target.checked);
    });

    review.querySelectorAll('input[name="store_payment_method"]').forEach(input => {
        input.addEventListener("change", syncPaymentMethodUi);
    });
}
function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function restoreDraftAfterScoutsLoad(draft) {
    if (!draft) return;

    if (Array.isArray(draft.selectedScoutIds)) {
        const validIds = new Set(scouts.map(s => s.id));
        selectedScoutIds = new Set(draft.selectedScoutIds.filter(id => validIds.has(id)));
    }

    if (draft.allocations && typeof draft.allocations === "object") {
        allocations = draft.allocations;
    }

    normalizeAllocations();
    renderScoutPicker();
}

function initializeForm(draft) {
    const form = document.querySelector("#customer-scout-form");

    form.addEventListener("input", event => {
        updateContinueState();
        saveDraft();
        if (event.target?.name === "fulfillment_method") {
            shippingQuote = null;
            renderCartReview();
            if (event.target.value === FULFILLMENT_SHIPPING) refreshShippingQuote();
        } else if (["address_line_1","address_line_2","city","state","postal_code"].includes(event.target?.name)) {
            shippingQuote = null;
            scheduleShippingQuote();
        }
    });

    form.addEventListener("submit", event => {
        event.preventDefault();

        if (!form.reportValidity()) return;
        if (!allocationIsComplete()) {
            renderAllocations();
            return;
        }

        saveDraft();
        buildReview();

        const checkoutHeading = document.querySelector(".checkout-heading");
        form.hidden = true;
        if (checkoutHeading) checkoutHeading.hidden = true;

        const finalReview = document.querySelector("#final-review");
        finalReview.hidden = false;
        document.body.classList.add("final-review-mode");
        window.scrollTo({ top: 0, behavior: "smooth" });
    });

    document.querySelector("#edit-information").addEventListener("click", () => {
        document.querySelector("#final-review").hidden = true;

        const checkoutHeading = document.querySelector(".checkout-heading");
        if (checkoutHeading) checkoutHeading.hidden = false;

        form.hidden = false;
        document.body.classList.remove("final-review-mode");
        window.scrollTo({ top: 0, behavior: "smooth" });
    });

    document.querySelector("#split-evenly").addEventListener("click", splitAllEvenly);

    const paymentButton = document.querySelector("#continue-to-payment");
    if (paymentButton) {
        paymentButton.addEventListener("click", continueToPayment);
    }

    restoreCustomerDraft(draft);
    updateContinueState();
}


function buildStorefrontOrderPayload() {
    const form = document.querySelector("#customer-scout-form");
    const customer = Object.fromEntries(new FormData(form).entries());
    customer.phone = normalizePhoneNumber(customer.phone) || "";
    const fulfillmentMethod = selectedFulfillmentMethod();
    delete customer.fulfillment_method;

    const items = productCartItems().map(({ item, key }) => ({
        product_id: item.productId,
        grind: item.grind,
        quantity: Number(item.quantity),
        allocations: Object.entries(allocations[key] || {})
            .filter(([, quantity]) => Number(quantity) > 0)
            .map(([scoutId, quantity]) => ({
                scout_id: scoutId,
                quantity: Number(quantity)
            }))
    }));

    const paymentMethod = selectedPaymentMethod();

    const processingCost = paymentMethod === PAYMENT_METHOD_CASH
        ? 0
        : cart
            .filter(item => item.type === "processing")
            .reduce((sum, item) => sum + (Number(item.unitPrice) * Number(item.quantity)), 0);

    const requestFingerprint = JSON.stringify({customer, items, processingCost, fulfillmentMethod});
    let attempt = JSON.parse(sessionStorage.getItem("friends323PaypalAttempt") || "null");
    if (!attempt || attempt.fingerprint !== requestFingerprint) {
        attempt = {fingerprint: requestFingerprint, key: crypto.randomUUID()};
        sessionStorage.setItem("friends323PaypalAttempt", JSON.stringify(attempt));
    }
    return {
        request_key: attempt.key,
        customer,
        items,
        processing_cost: processingCost,
        payment_method: paymentMethod,
        fulfillment_method: fulfillmentMethod
    };
}

async function continueToPayment() {
    const button = document.querySelector("#continue-to-payment");
    const result = document.querySelector("#checkout-result");

    if (!button || !result) return;

    if (!allocationIsComplete()) {
        result.hidden = false;
        result.className = "test-order-result test-order-result--error";
        result.textContent = "Every coffee bag must be assigned to a Scout before continuing.";
        return;
    }

    const paymentMethod = selectedPaymentMethod();

    if (selectedFulfillmentMethod() === FULFILLMENT_SHIPPING && (!shippingEnabled || !matchingShippingRate() || !shippingQuote || shippingQuoteLoading)) {
        result.hidden = false;
        result.className = "test-order-result test-order-result--error";
        result.textContent = "Shipping is not currently available for this order. Please go back and choose pickup or local delivery.";
        return;
    }

    button.disabled = true;
    button.textContent = paymentMethod === PAYMENT_METHOD_CASH
        ? "Placing Cash Order…"
        : "Preparing Secure Checkout…";

    result.hidden = false;
    result.className = "test-order-result";
    result.textContent = paymentMethod === PAYMENT_METHOD_CASH
        ? "Creating your Friends of 323 cash order…"
        : "Creating your secure PayPal checkout…";

    try {
        const response = await fetch(PAYPAL_CREATE_ORDER_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify(buildStorefrontOrderPayload())
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || "Unable to prepare secure payment.");
        }

        localStorage.setItem("friendsOf323PendingOrder", JSON.stringify({
            order_id: data.order_id,
            order_number: data.order_number,
            store_order_number: data.store_order_number,
            payment_method: data.payment_method,
            fulfillment_method: data.fulfillment_method || selectedFulfillmentMethod(),
            checkout_session_id: data.checkout_session_id || null,
            created_at: new Date().toISOString()
        }));

        if (data.payment_method === PAYMENT_METHOD_CASH) {
            localStorage.removeItem(CART_STORAGE_KEY);
            localStorage.removeItem(CHECKOUT_STORAGE_KEY);

            window.location.assign(
                `cash-order-success.html?order=${encodeURIComponent(data.store_order_number)}`
            );
            return;
        }

        if (!data.checkout_url) {
            throw new Error("The payment service did not return a checkout URL.");
        }

        window.location.assign(data.checkout_url);

    } catch (error) {
        if (/expired/i.test(error.message || "")) sessionStorage.removeItem("friends323PaypalAttempt");
        console.error("Store order preparation failed:", error);

        result.className = "test-order-result test-order-result--error";
        result.innerHTML = `
            <strong>We could not complete the order.</strong>
            <span>${escapeHtml(error.message)}</span>
        `;

        button.disabled = false;
        button.textContent = selectedPaymentMethod() === PAYMENT_METHOD_CASH
            ? "Place Cash Order"
            : "Continue to Secure Payment";
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    initializeMenu();

    cart = loadCart();
    const empty = document.querySelector("#checkout-empty");
    const form = document.querySelector("#customer-scout-form");
    const phoneInput = document.querySelector("#phone");
    if (phoneInput) {
        phoneInput.addEventListener("input", () => {
            phoneInput.value = formatPhoneNumber(phoneInput.value);
        });
    }

    if (!cart.length) {
        empty.hidden = false;
        form.hidden = true;
        return;
    }

    renderCartReview();

    const draft = loadDraft();
    initializeForm(draft);

    await loadShippingRates();
    if (selectedFulfillmentMethod() === FULFILLMENT_SHIPPING) await refreshShippingQuote({ silent:true });
    await loadScouts();
    restoreDraftAfterScoutsLoad(draft);

    const searchInput = document.querySelector("#scout-search-input");
    if (searchInput) {
        searchInput.addEventListener("input", renderScoutResults);
    }

    updateContinueState();
});
