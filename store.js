const PRODUCT_FEED_URL = "/.netlify/functions/store-products";
const STORE_ANNOUNCEMENT_URL = "/.netlify/functions/store-announcement";
const CART_STORAGE_KEY = "friendsOf323StorefrontCart";
const STRIPE_CARD_RATE = 0.029;
const STRIPE_FIXED_FEE = 0.30;

const PRODUCT_DISPLAY = [
    {
        key: "heritage-dark",
        match: name => name.includes("heritage") && name.includes("dark"),
        title: "Heritage Dark Roast",
        image: "images/dark-roast.png",
        accentClass: "store-product-card--dark",
        description: "A bold, full-bodied dark roast from our Heritage Coffee collection."
    },
    {
        key: "heritage-medium",
        match: name => name.includes("heritage") && name.includes("medium"),
        title: "Heritage Medium Roast",
        image: "images/medium-roast.png",
        accentClass: "store-product-card--medium",
        description: "A smooth, balanced medium roast made for an easy everyday cup."
    },
    {
        key: "heritage-decaf",
        match: name => name.includes("heritage") && name.includes("decaf"),
        title: "Heritage Decaf",
        image: "images/decaf.png",
        accentClass: "store-product-card--decaf",
        description: "The Heritage coffee experience without the caffeine."
    },
    {
        key: "founders-medium",
        match: name => name.includes("founder") && name.includes("medium"),
        title: "Founder's Series Medium Roast",
        image: "images/founders-series.png",
        accentClass: "store-product-card--founders",
        description: "A distinctive medium roast honoring the people who helped make the fundraiser possible."
    },
    {
        key: "founders-decaf",
        match: name => name.includes("founder") && name.includes("decaf"),
        title: "Founder's Series Decaf",
        image: "images/founders-series-decaf.png",
        accentClass: "store-product-card--founders",
        description: "The decaf version of our distinctive Founder's Series coffee."
    }
];

let catalogProducts = [];
let cart = loadCart();

function normalizeName(value) {
    return String(value || "").toLowerCase();
}

function money(value) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD"
    }).format(Number(value || 0));
}


function coffeeSubtotal() {
    return cart
        .filter(item => item.type === "product")
        .reduce((sum, item) => sum + (Number(item.unitPrice) * Number(item.quantity)), 0);
}

function calculateProcessingSupport(subtotal) {
    const amount = Number(subtotal || 0);
    if (amount <= 0) return 0;

    // Gross up the optional support so the Stripe fee charged on
    // the support itself is also covered. Round upward to the cent
    // to avoid coming up a penny short due to processor rounding.
    const raw = ((amount * STRIPE_CARD_RATE) + STRIPE_FIXED_FEE)
        / (1 - STRIPE_CARD_RATE);

    return Math.ceil((raw - Number.EPSILON) * 100) / 100;
}

function processingSupportItem() {
    return cart.find(item => item.type === "processing") || null;
}

function syncProcessingSupport() {
    const existing = processingSupportItem();
    if (!existing) return;

    const amount = calculateProcessingSupport(coffeeSubtotal());

    if (amount <= 0) {
        cart = cart.filter(item => item.type !== "processing");
        saveCart();
        return;
    }

    existing.unitPrice = amount;
    existing.quantity = 1;
    saveCart();
}

function sizeWeight(size) {
    if (size === "12oz") return 12;
    if (size === "16oz") return 16;
    return 999;
}

function loadCart() {
    try {
        const raw = localStorage.getItem(CART_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];

        // Backward compatibility with carts created before grind selection existed.
        return parsed.map(item => ({
            ...item,
            grind: item.type === "product" ? (item.grind || "ground") : null
        }));
    } catch {
        return [];
    }
}

function saveCart() {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
}

function selectedProductForCard(card) {
    const selected = card.querySelector(".store-size-option.is-selected");
    if (!selected) return null;

    return catalogProducts.find(product => product.id === selected.dataset.productId) || null;
}

function selectedGrindForCard(card) {
    const selected = card.querySelector('input[name^="grind-"]:checked');
    return selected ? selected.value : null;
}

function updateAddButton(card) {
    const action = card.querySelector(".store-card-action");
    const product = selectedProductForCard(card);
    const grind = selectedGrindForCard(card);

    action.disabled = !(product && grind);
    action.textContent = product && grind
        ? `Add ${product.bag_size} ${grind === "whole_bean" ? "Whole Bean" : "Ground"} to Cart`
        : "Select Size & Grind";
}

function createVariantButton(product) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "store-size-option";
    button.dataset.productId = product.id;

    const size = document.createElement("span");
    size.className = "store-size-option__size";
    size.textContent = product.bag_size;

    const price = document.createElement("span");
    price.className = "store-size-option__price";
    price.textContent = money(product.sale_price);

    button.append(size, price);

    button.addEventListener("click", () => {
        const card = button.closest(".store-product-card");

        card.querySelectorAll(".store-size-option.is-selected")
            .forEach(item => item.classList.remove("is-selected"));

        button.classList.add("is-selected");
        updateAddButton(card);
    });

    return button;
}

function createGrindSelector(config) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "store-grind-options";

    const legend = document.createElement("legend");
    legend.textContent = "Grind";

    const choices = [
        { value: "whole_bean", label: "Whole Bean" },
        { value: "ground", label: "Ground" }
    ];

    choices.forEach((choice, index) => {
        const label = document.createElement("label");
        label.className = "store-grind-option";

        const input = document.createElement("input");
        input.type = "radio";
        input.name = `grind-${config.key}`;
        input.value = choice.value;

        const text = document.createElement("span");
        text.textContent = choice.label;

        input.addEventListener("change", () => {
            const card = input.closest(".store-product-card");
            updateAddButton(card);
        });

        label.append(input, text);
        fieldset.append(label);
    });

    fieldset.prepend(legend);
    return fieldset;
}

function createProductCard(config, variants) {
    const card = document.createElement("article");
    card.className = `store-product-card ${config.accentClass}`;

    const imageWrap = document.createElement("div");
    imageWrap.className = "store-product-card__image-wrap";

    const image = document.createElement("img");
    image.src = config.image;
    image.alt = config.title;
    image.loading = "lazy";
    imageWrap.appendChild(image);

    const body = document.createElement("div");
    body.className = "store-product-card__body";

    const title = document.createElement("h3");
    title.textContent = config.title;

    const description = document.createElement("p");
    description.className = "store-product-card__description";
    description.textContent = config.description;

    const variantList = document.createElement("div");
    variantList.className = "store-size-options";
    variantList.setAttribute("aria-label", `${config.title} sizes`);

    variants
        .sort((a, b) => sizeWeight(a.bag_size) - sizeWeight(b.bag_size))
        .forEach(product => variantList.appendChild(createVariantButton(product)));

    const grindSelector = createGrindSelector(config);

    const action = document.createElement("button");
    action.type = "button";
    action.className = "store-card-action";
    action.disabled = true;
    action.textContent = "Select Size & Grind";

    action.addEventListener("click", () => {
        const product = selectedProductForCard(card);
        const grind = selectedGrindForCard(card);
        if (!product || !grind) return;

        addProductToCart(product, grind);
        action.textContent = "Added ✓";

        window.setTimeout(() => updateAddButton(card), 900);
    });

    body.append(title, description, variantList, grindSelector, action);
    card.append(imageWrap, body);

    return card;
}

function createProcessingCard() {
    const card = document.createElement("article");
    card.className = "store-product-card store-product-card--processing";

    const imageWrap = document.createElement("div");
    imageWrap.className = "store-product-card__image-wrap store-product-card__image-wrap--processing";

    const image = document.createElement("img");
    image.src = "images/processing-cost.png";
    image.alt = "Processing Cost";
    image.loading = "lazy";
    imageWrap.appendChild(image);

    const body = document.createElement("div");
    body.className = "store-product-card__body";

    const title = document.createElement("h3");
    title.textContent = "Processing Cost";

    const description = document.createElement("p");
    description.className = "store-product-card__description";
    description.textContent =
        "Optional support to cover the standard online card processing cost so more of your coffee purchase supports Pack 323.";

    const price = document.createElement("div");
    price.className = "store-processing-price";
    price.dataset.processingAmount = "true";

    const action = document.createElement("button");
    action.type = "button";
    action.className = "store-card-action";
    action.dataset.processingAction = "true";

    action.addEventListener("click", () => {
        toggleProcessingSupport();
    });

    body.append(title, description, price, action);
    card.append(imageWrap, body);

    updateProcessingCard(card);
    return card;
}

function updateProcessingCard(card = document.querySelector(".store-product-card--processing")) {
    if (!card) return;

    const subtotal = coffeeSubtotal();
    const amount = calculateProcessingSupport(subtotal);
    const price = card.querySelector('[data-processing-amount="true"]');
    const action = card.querySelector('[data-processing-action="true"]');
    const included = Boolean(processingSupportItem());

    if (subtotal <= 0) {
        price.textContent = "Add coffee to calculate";
        action.textContent = "Processing Support Optional";
        action.disabled = true;
        return;
    }

    price.textContent = `${money(amount)} for this cart`;
    action.disabled = false;

    if (included) {
        action.textContent = `Remove ${money(amount)} Processing Support`;
        action.classList.add("store-card-action--remove");
    } else {
        action.textContent = `Add ${money(amount)} to Cover Processing`;
        action.classList.remove("store-card-action--remove");
    }
}

function toggleProcessingSupport() {
    const existing = processingSupportItem();

    if (existing) {
        cart = cart.filter(item => item.type !== "processing");
    } else {
        const amount = calculateProcessingSupport(coffeeSubtotal());
        if (amount <= 0) return;

        cart.push({
            type: "processing",
            productId: null,
            sku: "PROCESSING",
            productName: "Processing Cost Support",
            bagSize: null,
            grind: null,
            unitPrice: amount,
            quantity: 1
        });
    }

    saveCart();
    renderCart();
}

function addProductToCart(product, grind) {
    const existing = cart.find(item =>
        item.type === "product" &&
        item.productId === product.id &&
        item.grind === grind
    );

    if (existing) {
        existing.quantity += 1;
    } else {
        cart.push({
            type: "product",
            productId: product.id,
            sku: product.sku,
            productName: product.product_name,
            bagSize: product.bag_size,
            grind,
            unitPrice: Number(product.sale_price),
            quantity: 1
        });
    }

    syncProcessingSupport();
    saveCart();
    renderCart();
}

function changeQuantity(index, delta) {
    if (!cart[index]) return;

    cart[index].quantity += delta;

    if (cart[index].quantity <= 0) {
        cart.splice(index, 1);
    }

    syncProcessingSupport();
    saveCart();
    renderCart();
}

function removeCartItem(index) {
    cart.splice(index, 1);
    syncProcessingSupport();
    saveCart();
    renderCart();
}

function cartQuantity() {
    return cart
        .filter(item => item.type === "product")
        .reduce((sum, item) => sum + item.quantity, 0);
}

function cartTotal() {
    return cart.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
}

function renderCart() {
    const count = document.querySelector("#cart-count");
    const empty = document.querySelector("#cart-empty");
    const items = document.querySelector("#cart-items");
    const summary = document.querySelector("#cart-summary");
    const total = document.querySelector("#cart-total");

    const quantity = cartQuantity();
    count.textContent = `${quantity} ${quantity === 1 ? "item" : "items"}`;

    if (cart.length === 0) {
        empty.hidden = false;
        items.hidden = true;
        summary.hidden = true;
        items.innerHTML = "";

        // Reset the Processing Cost card immediately when the
        // last coffee item is removed from the cart.
        updateProcessingCard();
        return;
    }

    empty.hidden = true;
    items.hidden = false;
    summary.hidden = false;
    items.innerHTML = "";

    const displayItems = [
        ...cart
            .map((item, index) => ({ item, originalIndex: index }))
            .filter(entry => entry.item.type === "product"),
        ...cart
            .map((item, index) => ({ item, originalIndex: index }))
            .filter(entry => entry.item.type === "processing")
    ];

    displayItems.forEach(({ item, originalIndex }) => {
        const row = document.createElement("div");
        row.className = "cart-item";

        if (item.type === "processing") {
            row.classList.add("cart-item--processing");

            const details = document.createElement("div");
            details.className = "cart-item__details";

            const name = document.createElement("strong");
            name.textContent = "Processing Cost Support";

            const meta = document.createElement("span");
            meta.textContent = "Optional • recalculated automatically when your coffee order changes";

            details.append(name, meta);

            const lineTotal = document.createElement("strong");
            lineTotal.className = "cart-item__line-total";
            lineTotal.textContent = money(item.unitPrice);

            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "cart-item__remove";
            remove.textContent = "Remove";
            remove.addEventListener("click", () => {
                cart = cart.filter(entry => entry.type !== "processing");
                saveCart();
                renderCart();
            });

            row.append(details, lineTotal, remove);
            items.appendChild(row);
            return;
        }

        const details = document.createElement("div");
        details.className = "cart-item__details";

        const name = document.createElement("strong");
        name.textContent = item.productName;

        const meta = document.createElement("span");
        const grindLabel = item.grind === "whole_bean" ? "Whole Bean" : "Ground";
        meta.textContent = `${item.bagSize} • ${grindLabel} • ${money(item.unitPrice)} each`;

        details.append(name, meta);

        const quantityControls = document.createElement("div");
        quantityControls.className = "cart-item__quantity";

        const minus = document.createElement("button");
        minus.type = "button";
        minus.setAttribute("aria-label", `Decrease ${item.productName} quantity`);
        minus.textContent = "−";
        minus.addEventListener("click", () => changeQuantity(originalIndex, -1));

        const qty = document.createElement("span");
        qty.textContent = item.quantity;
        qty.setAttribute("aria-label", `Quantity ${item.quantity}`);

        const plus = document.createElement("button");
        plus.type = "button";
        plus.setAttribute("aria-label", `Increase ${item.productName} quantity`);
        plus.textContent = "+";
        plus.addEventListener("click", () => changeQuantity(originalIndex, 1));

        quantityControls.append(minus, qty, plus);

        const lineTotal = document.createElement("strong");
        lineTotal.className = "cart-item__line-total";
        lineTotal.textContent = money(item.unitPrice * item.quantity);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "cart-item__remove";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => removeCartItem(originalIndex));

        row.append(details, quantityControls, lineTotal, remove);
        items.appendChild(row);
    });

    total.textContent = money(cartTotal());
    updateProcessingCard();
}

function renderProducts(products) {
    catalogProducts = products;

    const grid = document.querySelector("#product-grid");
    const status = document.querySelector("#store-status");

    grid.innerHTML = "";

    PRODUCT_DISPLAY.forEach(config => {
        const variants = products.filter(product =>
            config.match(normalizeName(product.product_name))
        );

        if (variants.length > 0) {
            grid.appendChild(createProductCard(config, variants));
        }
    });

    grid.appendChild(createProcessingCard());

    status.hidden = true;
    grid.hidden = false;
}

function showError() {
    const status = document.querySelector("#store-status");
    status.classList.add("store-status--error");
    status.innerHTML = `
        <strong>We couldn't load the coffee catalog.</strong>
        <span>Please refresh the page or try again in a few minutes.</span>
    `;
}

async function loadProducts() {
    try {
        const response = await fetch(PRODUCT_FEED_URL, {
            headers: { Accept: "application/json" },
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(`Product feed returned ${response.status}`);
        }

        const data = await response.json();

        if (!Array.isArray(data.products)) {
            throw new Error("Product feed did not return a products array.");
        }

        renderProducts(data.products.filter(product => product.is_active));
    } catch (error) {
        console.error("Unable to load storefront products:", error);
        showError();
    }
}

async function loadStoreAnnouncement() {
    try {
        const response = await fetch(STORE_ANNOUNCEMENT_URL, {
            headers: { Accept: "application/json" },
            cache: "no-store"
        });
        if (!response.ok) return;

        const announcement = await response.json();
        if (!announcement?.enabled || !announcement.title || !announcement.message) return;

        const banner = document.querySelector("#store-announcement-banner");
        const bannerTitle = document.querySelector("#store-announcement-banner-title");
        const bannerMessage = document.querySelector("#store-announcement-banner-message");
        const dialog = document.querySelector("#store-announcement-dialog");
        const dialogTitle = document.querySelector("#store-announcement-title");
        const dialogMessage = document.querySelector("#store-announcement-message");

        bannerTitle.textContent = announcement.title;
        bannerMessage.textContent = announcement.message;
        dialogTitle.textContent = announcement.title;
        dialogMessage.textContent = announcement.message;
        banner.hidden = false;

        const noticeVersion = announcement.updated_at || `${announcement.title}|${announcement.message}`;
        const sessionKey = `friendsOf323Announcement:${noticeVersion}`;
        let alreadyShown = false;
        try {
            alreadyShown = sessionStorage.getItem(sessionKey) === "shown";
        } catch {
            alreadyShown = false;
        }

        const close = () => {
            if (dialog?.open) dialog.close();
            try { sessionStorage.setItem(sessionKey, "shown"); } catch {}
        };

        dialog?.querySelectorAll("[data-announcement-close]").forEach(button =>
            button.addEventListener("click", close)
        );
        dialog?.addEventListener("cancel", event => {
            event.preventDefault();
            close();
        });

        if (!alreadyShown && dialog) {
            try {
                dialog.showModal();
            } catch {
                dialog.setAttribute("open", "");
            }
        }
    } catch (error) {
        console.warn("Store announcement could not be loaded:", error);
    }
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

document.addEventListener("DOMContentLoaded", () => {
    initializeMenu();
    syncProcessingSupport();
    renderCart();
    loadProducts();
    loadStoreAnnouncement();
});
