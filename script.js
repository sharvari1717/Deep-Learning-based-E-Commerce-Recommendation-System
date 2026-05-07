const PRODUCTS_JSON_URL = "products.json";

let PRODUCTS = [];

async function loadProducts() {
  try {
    const res = await fetch(PRODUCTS_JSON_URL, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length) {
        PRODUCTS = data;
        return;
      }
    }
  } catch (_) {
  }

  const embedded = window.SHOP_EASE_EMBEDDED_PRODUCTS;
  if (Array.isArray(embedded) && embedded.length) {
    PRODUCTS = embedded;
    return;
  }

  throw new Error(
    "No catalog: add products.embed.js before script.js, or run python3 -m http.server 8080 and open http://localhost:8080."
  );
}

function showCatalogLoadError(message) {
  const grid = document.getElementById("productsGrid");
  const resultsInfo = document.getElementById("resultsInfo");
  if (grid) {
    grid.innerHTML = "";
    const div = document.createElement("div");
    div.className = "empty-state";
    div.textContent = message;
    grid.appendChild(div);
  }
  if (resultsInfo) {
    resultsInfo.textContent = "Catalog failed to load";
  }
}

let activeCategoryShortcut = "all";
let searchQuery = "";
let priceFilterValue = "all";
let ratingFilterValue = "all";
let categoryFilterValue = "all";
let stockFilterValue = "all";
let activeSearchTokens = [];
let lastRankingHint = "";
let personalizationToggleOn = true;
let parsedIntentQuery = "";

const cart = [];
const wishlist = [];
const compareSelected = [];
let checkoutTimers = [];
let checkoutInProgress = false;
let currentOrderDetailsId = null;

let currentModalProductId = null;
const USER_PROFILE_KEY = "shopease_user_profile_v1";
const PERSONALIZE_TOGGLE_KEY = "shopease_personalize_toggle_v1";
const RECOMMENDER_HISTORY_KEY = "shopease_reco_history_v1";
const RECOMMENDER_FEEDBACK_KEY = "shopease_reco_feedback_v1";
const PLACED_ORDERS_KEY = "shopease_placed_orders_v1";
const WISHLIST_KEY = "shopease_wishlist_v1";
const MAX_HISTORY_EVENTS = 200;
const SESSION_SIGNAL_WINDOW = 10;
const SESSION_BOOST_WEIGHT = 0.3;
const sessionStartTs = Date.now();
let recommendationDiversity = 35;
let userProfile = {
  category: {},
  brand: {},
  priceBand: {},
};
let recommenderHistory = {
  events: [],
};
let recommenderFeedback = {
  hiddenProductIds: {},
  hiddenBrands: {},
  hiddenCategories: {},
};
let placedOrders = [];

/** Flipkart top-level → display label (filled after catalog loads). */
let categoryLabelsBySlug = new Map();

function rebuildCategoryLabelsMap() {
  categoryLabelsBySlug = new Map();
  PRODUCTS.forEach((p) => {
    if (p.category && !categoryLabelsBySlug.has(p.category)) {
      categoryLabelsBySlug.set(
        p.category,
        p.categoryLabel || prettifyCategorySlug(p.category)
      );
    }
  });
}

function prettifyCategorySlug(slug) {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatCategoryLabel(slug) {
  if (!slug || slug === "all") return "All";
  return categoryLabelsBySlug.get(slug) || prettifyCategorySlug(slug);
}

function normalizeProductId(id) {
  const n = Number(id);
  return Number.isNaN(n) ? id : n;
}

function initializeProductRuntimeData() {
  PRODUCTS.forEach((p) => {
    p.stock = computeStockForProduct(p);
  });
}

function buildCategoryNavAndFilter() {
  const nav = document.getElementById("categoryNav");
  const sel = document.getElementById("categoryFilter");
  if (!nav || !sel) return;

  nav.querySelectorAll(".category-btn:not([data-category=all])").forEach((b) => b.remove());
  while (sel.options.length > 1) sel.remove(1);

  const sorted = [...categoryLabelsBySlug.entries()].sort((a, b) =>
    a[1].localeCompare(b[1])
  );
  sorted.forEach(([slug, label]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "category-btn";
    btn.dataset.category = slug;
    btn.textContent = label;
    nav.appendChild(btn);

    const opt = document.createElement("option");
    opt.value = slug;
    opt.textContent = label;
    sel.appendChild(opt);
  });
}

function formatPrice(value) {
  return `₹${value.toLocaleString("en-IN")}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function highlightText(text, tokens) {
  let out = escapeHtml(text);
  const uniq = [...new Set(tokens.filter((t) => t.length > 1))].slice(0, 6);
  uniq.forEach((t) => {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(`(${escaped})`, "ig"),
      '<span class="highlight">$1</span>'
    );
  });
  return out;
}

function getPriceBand(price) {
  if (price < 1000) return "0-999";
  if (price < 5000) return "1000-4999";
  if (price < 10000) return "5000-9999";
  return "10000+";
}

function loadUserProfile() {
  try {
    const raw = localStorage.getItem(USER_PROFILE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      userProfile = {
        category: parsed.category || {},
        brand: parsed.brand || {},
        priceBand: parsed.priceBand || {},
      };
    }
  } catch (_) {
    userProfile = { category: {}, brand: {}, priceBand: {} };
  }
}

function saveUserProfile() {
  try {
    localStorage.setItem(USER_PROFILE_KEY, JSON.stringify(userProfile));
  } catch (_) {}
}

function loadPersonalizationToggle() {
  try {
    const raw = localStorage.getItem(PERSONALIZE_TOGGLE_KEY);
    if (raw == null) return;
    personalizationToggleOn = raw === "1";
  } catch (_) {}
}

function savePersonalizationToggle() {
  try {
    localStorage.setItem(PERSONALIZE_TOGGLE_KEY, personalizationToggleOn ? "1" : "0");
  } catch (_) {}
}

function loadRecommenderHistory() {
  try {
    const raw = localStorage.getItem(RECOMMENDER_HISTORY_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.events)) {
      recommenderHistory = {
        events: parsed.events.filter((e) => e && e.productId && e.type),
      };
    }
  } catch (_) {
    recommenderHistory = { events: [] };
  }
}

function saveRecommenderHistory() {
  try {
    localStorage.setItem(RECOMMENDER_HISTORY_KEY, JSON.stringify(recommenderHistory));
  } catch (_) {}
}

function loadRecommenderFeedback() {
  try {
    const raw = localStorage.getItem(RECOMMENDER_FEEDBACK_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    recommenderFeedback = {
      hiddenProductIds: parsed.hiddenProductIds || {},
      hiddenBrands: parsed.hiddenBrands || {},
      hiddenCategories: parsed.hiddenCategories || {},
    };
  } catch (_) {
    recommenderFeedback = { hiddenProductIds: {}, hiddenBrands: {}, hiddenCategories: {} };
  }
}

function saveRecommenderFeedback() {
  try {
    localStorage.setItem(RECOMMENDER_FEEDBACK_KEY, JSON.stringify(recommenderFeedback));
  } catch (_) {}
}

function loadPlacedOrders() {
  try {
    const raw = localStorage.getItem(PLACED_ORDERS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) placedOrders = parsed;
  } catch (_) {
    placedOrders = [];
  }
}

function savePlacedOrders() {
  try {
    localStorage.setItem(PLACED_ORDERS_KEY, JSON.stringify(placedOrders));
  } catch (_) {}
}

function loadWishlist() {
  try {
    const raw = localStorage.getItem(WISHLIST_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      wishlist.splice(
        0,
        wishlist.length,
        ...parsed.map((id) => normalizeProductId(id))
      );
    }
  } catch (_) {}
}

function saveWishlist() {
  try {
    localStorage.setItem(WISHLIST_KEY, JSON.stringify(wishlist));
  } catch (_) {}
}

function hashString(text) {
  let h = 0;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function computeStockForProduct(product) {
  const r = hashString(product.id) % 20;
  if (r <= 1) return 0;
  if (r <= 4) return 3;
  if (r <= 8) return 7;
  return 15;
}

function inferOrderStatus(order) {
  if (!order) return "Placed";
  if (order.status === "Cancelled") return "Cancelled";
  if (order.status === "Return Requested") return "Return Requested";
  if (order.status === "Refunded") return "Refunded";
  const ageMs = Date.now() - Number(order.createdAt || 0);
  return ageMs > 5 * 60 * 1000 ? "Delivered" : "Placed";
}

function getStockLabel(product) {
  const n = Number(product.stock || 0);
  if (n <= 0) return "Out of stock";
  if (n <= 3) return `Only ${n} left`;
  return "In stock";
}

function getDeliveryEstimateDays(product, city = "") {
  const c = String(city || "default").toLowerCase();
  const base = (hashString(product.id + c) % 3) + 2;
  return product.stock <= 3 ? base + 1 : base;
}

function recordInteraction(productId, type) {
  if (!productId || !type) return;
  recommenderHistory.events.push({ productId, type, ts: Date.now() });
  if (recommenderHistory.events.length > MAX_HISTORY_EVENTS) {
    recommenderHistory.events = recommenderHistory.events.slice(
      recommenderHistory.events.length - MAX_HISTORY_EVENTS
    );
  }
  saveRecommenderHistory();
  renderTasteProfile();

  // Trigger DL incremental retrain after every few interactions
  if (window.DL_RECOMMENDER && typeof window.DL_RECOMMENDER.onNewInteraction === 'function') {
    window.DL_RECOMMENDER.onNewInteraction(recommenderHistory.events, PRODUCTS).catch(console.warn);
  }
}

function isHiddenByFeedback(product) {
  if (!product) return true;
  if (recommenderFeedback.hiddenProductIds[product.id]) return true;
  if (recommenderFeedback.hiddenCategories[product.category]) return true;
  if (
    product.brand &&
    recommenderFeedback.hiddenBrands[String(product.brand).toLowerCase()]
  ) {
    return true;
  }
  return false;
}

function getHiddenFeedbackEntries() {
  const out = [];
  Object.keys(recommenderFeedback.hiddenProductIds || {}).forEach((id) => {
    if (!recommenderFeedback.hiddenProductIds[id]) return;
    const p = PRODUCTS.find((item) => item.id === id);
    out.push({
      type: "product",
      key: id,
      label: p ? p.name : `Product ${id}`,
    });
  });
  Object.keys(recommenderFeedback.hiddenBrands || {}).forEach((brandKey) => {
    if (!recommenderFeedback.hiddenBrands[brandKey]) return;
    out.push({
      type: "brand",
      key: brandKey,
      label: `Brand: ${brandKey}`,
    });
  });
  Object.keys(recommenderFeedback.hiddenCategories || {}).forEach((slug) => {
    if (!recommenderFeedback.hiddenCategories[slug]) return;
    out.push({
      type: "category",
      key: slug,
      label: `Category: ${formatCategoryLabel(slug)}`,
    });
  });
  return out;
}

function clearAllHiddenFeedback() {
  recommenderFeedback = {
    hiddenProductIds: {},
    hiddenBrands: {},
    hiddenCategories: {},
  };
  saveRecommenderFeedback();
  renderHiddenRecoManager();
  applyFilters();
  if (currentModalProductId) renderSimilarItems(currentModalProductId);
}

function unhideFeedbackEntry(type, key) {
  if (!type || !key) return;
  if (type === "product") delete recommenderFeedback.hiddenProductIds[key];
  if (type === "brand") delete recommenderFeedback.hiddenBrands[key];
  if (type === "category") delete recommenderFeedback.hiddenCategories[key];
  saveRecommenderFeedback();
  renderHiddenRecoManager();
  applyFilters();
  if (currentModalProductId) renderSimilarItems(currentModalProductId);
}

function renderHiddenRecoManager() {
  const wrap = document.getElementById("hiddenRecoManager");
  const list = document.getElementById("hiddenRecoList");
  const clearBtn = document.getElementById("clearHiddenRecoBtn");
  if (!wrap || !list || !clearBtn) return;
  const entries = getHiddenFeedbackEntries();
  if (!entries.length) {
    wrap.hidden = true;
    list.innerHTML = "";
    return;
  }
  wrap.hidden = false;
  list.innerHTML = entries
    .map(
      (entry) =>
        `<span class="hidden-reco-chip">${escapeHtml(entry.label)} <button type="button" data-unhide-type="${entry.type}" data-unhide-key="${escapeHtml(entry.key)}">Unhide</button></span>`
    )
    .join("");
}

function inc(obj, key, by = 1) {
  if (!key) return;
  obj[key] = (obj[key] || 0) + by;
}

function trackProductInteraction(product, type) {
  if (!product) return;
  const weight = type === "add" ? 3 : 1;
  inc(userProfile.category, product.category, weight);
  inc(userProfile.priceBand, getPriceBand(product.price), weight);
  if (product.brand) inc(userProfile.brand, String(product.brand).toLowerCase(), weight);
  saveUserProfile();
}

function getPersonalizationBoost(product) {
  const c = userProfile.category[product.category] || 0;
  const p = userProfile.priceBand[getPriceBand(product.price)] || 0;
  const b = product.brand ? userProfile.brand[String(product.brand).toLowerCase()] || 0 : 0;
  return c * 0.12 + p * 0.08 + b * 0.04;
}

function getPersonalizationReason(product) {
  const parts = [];
  if ((userProfile.category[product.category] || 0) > 0) {
    parts.push(`you prefer ${formatCategoryLabel(product.category)}`);
  }
  if ((userProfile.priceBand[getPriceBand(product.price)] || 0) > 0) {
    parts.push("your usual price band");
  }
  if (product.brand && (userProfile.brand[String(product.brand).toLowerCase()] || 0) > 0) {
    parts.push(`brand ${product.brand}`);
  }
  return parts.length ? `Personalized: ${parts.slice(0, 2).join(" + ")}` : "";
}

// TF-IDF + cosine similarity for search (in-browser, no API).
const SEARCH_STOP_WORDS = new Set([
  "with",
  "and",
  "or",
  "for",
  "of",
  "to",
  "in",
  "on",
  "at",
  "a",
  "an",
  "the",
  "your",
  "you",
  "are",
  "is",
  "be",
  "this",
  "that",
  "it",
  "as",
  "into",
  "over",
  "under",
  "any",
  "all",
]);

let SEARCH_MODEL = null;

function tokenizeForSearch(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length > 1 && !SEARCH_STOP_WORDS.has(t));
}

function buildSearchModel() {
  const docsTokens = PRODUCTS.map((product) => {
    const categoryLabel = formatCategoryLabel(product.category);
    return tokenizeForSearch(
      `${product.name} ${product.description} ${product.category} ${categoryLabel}`
    );
  });

  const N = docsTokens.length;

  const df = new Map();
  docsTokens.forEach((tokens) => {
    const uniqueTokens = new Set(tokens);
    uniqueTokens.forEach((term) => {
      df.set(term, (df.get(term) || 0) + 1);
    });
  });

  const idf = new Map();
  df.forEach((docCount, term) => {
    idf.set(term, Math.log((N + 1) / (docCount + 1)) + 1);
  });

  const docVectorsById = new Map();
  const docNormsById = new Map();

  PRODUCTS.forEach((product, i) => {
    const tokens = docsTokens[i];
    const total = tokens.length || 1;

    const tfCounts = new Map();
    tokens.forEach((t) => tfCounts.set(t, (tfCounts.get(t) || 0) + 1));

    const vec = new Map();
    let sumSquares = 0;

    tfCounts.forEach((count, term) => {
      const tf = count / total;
      const termIdf = idf.get(term) ?? Math.log((N + 1) / 1) + 1;
      const weight = tf * termIdf;
      vec.set(term, weight);
      sumSquares += weight * weight;
    });

    docVectorsById.set(product.id, vec);
    docNormsById.set(product.id, Math.sqrt(sumSquares));
  });

  SEARCH_MODEL = { idf, docVectorsById, docNormsById, N };
}

function vectorizeQueryTokens(tokens) {
  if (!SEARCH_MODEL) buildSearchModel();

  const total = tokens.length || 1;
  const tfCounts = new Map();
  tokens.forEach((t) => tfCounts.set(t, (tfCounts.get(t) || 0) + 1));

  const vec = new Map();
  let sumSquares = 0;

  tfCounts.forEach((count, term) => {
    const tf = count / total;
    const termIdf = SEARCH_MODEL.idf.get(term) ?? Math.log((SEARCH_MODEL.N + 1) / 1) + 1;
    const weight = tf * termIdf;
    vec.set(term, weight);
    sumSquares += weight * weight;
  });

  return { vec, norm: Math.sqrt(sumSquares) };
}

function cosineSimilaritySparse(queryVec, queryNorm, docVec, docNorm) {
  if (!queryVec || !docVec || !queryNorm || !docNorm) return 0;
  let dot = 0;
  queryVec.forEach((qw, term) => {
    const dv = docVec.get(term);
    if (dv) dot += qw * dv;
  });
  return dot / (queryNorm * docNorm);
}

function applyRecommendationFeedback(product, mode) {
  if (!product || !mode) return;
  if (mode === "product") {
    recommenderFeedback.hiddenProductIds[product.id] = 1;
    recordInteraction(product.id, "not_interested");
  } else if (mode === "brand" && product.brand) {
    recommenderFeedback.hiddenBrands[String(product.brand).toLowerCase()] = 1;
    recordInteraction(product.id, "not_interested");
  } else if (mode === "category" && product.category) {
    recommenderFeedback.hiddenCategories[product.category] = 1;
    recordInteraction(product.id, "not_interested");
  }
  saveRecommenderFeedback();
  renderHiddenRecoManager();
  applyFilters();
  if (currentModalProductId) renderSimilarItems(currentModalProductId);
}

function createProductCard(
  product,
  { recommended = false, recommendationReason = "" } = {}
) {
  const card = document.createElement("article");
  card.className = "product-card";
  card.setAttribute("tabindex", "0");
  card.dataset.productId = product.id;

  card.innerHTML = `
    <div class="product-image">${product.emoji}</div>
    <h3 class="product-title">${highlightText(product.name, activeSearchTokens)}</h3>
    <div class="product-meta">
      <span class="price">${formatPrice(product.price)}</span>
      <span class="badge rating-badge">${product.rating.toFixed(1)}★</span>
    </div>
    <div class="product-meta">
      <span class="badge category-pill">${formatCategoryLabel(product.category)}</span>
      ${
        recommended
          ? '<span class="badge recommended-badge">Recommended</span>'
          : ""
      }
    </div>
    <div class="product-meta">
      <span class="results-info">${getStockLabel(product)}</span>
      <span class="results-info">ETA ${getDeliveryEstimateDays(
        product,
        document.getElementById("checkoutCity")?.value || ""
      )}d</span>
    </div>
    <div class="product-meta">
      <button class="compare-toggle ${
        compareSelected.includes(product.id) ? "active" : ""
      }" type="button">
        ${
          compareSelected.includes(product.id)
            ? "Selected for compare"
            : "Compare"
        }
      </button>
      <button class="compare-toggle wishlist-toggle" type="button">${
        wishlist.includes(product.id) ? "Saved" : "Save"
      }</button>
    </div>
    ${
      recommended && recommendationReason
        ? `<p class="recommendation-item-reason">${escapeHtml(recommendationReason)}</p>`
        : ""
    }
    ${
      recommended
        ? `<div class="recommendation-feedback-row">
            <button type="button" class="recommendation-feedback-btn" data-hide="product">Not interested</button>
            <button type="button" class="recommendation-feedback-btn" data-hide="${
              product.brand ? "brand" : "category"
            }">Hide this ${product.brand ? "brand" : "category"}</button>
          </div>`
        : ""
    }
  `;

  card.addEventListener("click", () => openProductModal(product.id));
  card.addEventListener("keypress", (event) => {
    if (event.key === "Enter") openProductModal(product.id);
  });
  const compareBtn = card.querySelector(".compare-toggle");
  compareBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleCompare(product.id);
  });
  const wishlistBtn = card.querySelector(".wishlist-toggle");
  if (wishlistBtn) {
    wishlistBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleWishlist(product.id);
    });
  }
  if (recommended) {
    card.querySelectorAll(".recommendation-feedback-btn").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        applyRecommendationFeedback(product, btn.getAttribute("data-hide"));
      });
    });
  }

  return card;
}

function toggleCompare(productId) {
  const idx = compareSelected.indexOf(productId);
  if (idx >= 0) {
    compareSelected.splice(idx, 1);
  } else {
    if (compareSelected.length >= 3) return;
    compareSelected.push(productId);
    recordInteraction(productId, "compare");
  }
  renderCompareBar();
  applyFilters();
}

function clearCompare() {
  compareSelected.splice(0, compareSelected.length);
  renderCompareBar();
  applyFilters();
}

function renderCompareTable() {
  const wrap = document.getElementById("compareTableWrap");
  if (!wrap) return;
  const selectedProducts = compareSelected
    .map((id) => PRODUCTS.find((p) => p.id === id))
    .filter(Boolean);
  if (!selectedProducts.length) {
    wrap.innerHTML = '<p class="empty-state">Select 2-3 products to compare.</p>';
    return;
  }
  const minPrice = Math.min(...selectedProducts.map((p) => p.price));
  const maxRating = Math.max(...selectedProducts.map((p) => p.rating));
  const maxValue = Math.max(
    ...selectedProducts.map((p) => p.rating / Math.max(1, p.price))
  );
  const cheapestAll = selectedProducts.filter((p) => p.price === minPrice);
  const bestRatedAll = selectedProducts.filter((p) => p.rating === maxRating);
  const bestValueAll = selectedProducts.filter(
    (p) => p.rating / Math.max(1, p.price) === maxValue
  );
  const labelList = (items) =>
    items.length > 1 ? `Tie (${items.length}): ${items.map((p) => p.name).join(", ")}` : items[0].name;
  const ths = selectedProducts.map((p) => `<th>${p.name}</th>`).join("");
  const cells = (fieldFn) =>
    selectedProducts.map((p) => `<td>${fieldFn(p)}</td>`).join("");
  wrap.innerHTML = `
    <div class="compare-summary">
      <span class="badge recommended-badge">Cheapest: ${labelList(cheapestAll)}</span>
      <span class="badge rating-badge">Top rated: ${labelList(bestRatedAll)}</span>
      <span class="badge quality-badge">Best value: ${labelList(bestValueAll)}</span>
    </div>
    <table class="compare-table">
      <thead><tr><th>Field</th>${ths}</tr></thead>
      <tbody>
        <tr><th>Category</th>${cells((p) => formatCategoryLabel(p.category))}</tr>
        <tr><th>Price</th>${cells((p) => formatPrice(p.price))}</tr>
        <tr><th>Rating</th>${cells((p) => `${p.rating.toFixed(1)}★`)}</tr>
        <tr><th>Brand</th>${cells((p) => p.brand || "—")}</tr>
      </tbody>
    </table>
  `;
}

function renderCompareBar() {
  const bar = document.getElementById("compareBar");
  const count = document.getElementById("compareCount");
  const openBtn = document.getElementById("compareOpenBtn");
  if (!bar || !count || !openBtn) return;
  bar.hidden = compareSelected.length === 0;
  count.textContent = `${compareSelected.length} selected`;
  openBtn.disabled = compareSelected.length < 2;
}

function renderProducts(products) {
  const grid = document.getElementById("productsGrid");
  const resultsInfo = document.getElementById("resultsInfo");

  if (!products.length) {
    grid.innerHTML =
      '<div class="empty-state">No products match your filters. Try changing or clearing filters.</div>';
    resultsInfo.textContent = "0 products found";
    return;
  }

  const fragment = document.createDocumentFragment();

  products.forEach((product) => {
    fragment.appendChild(createProductCard(product));
  });

  grid.innerHTML = "";
  grid.appendChild(fragment);
  resultsInfo.textContent = `${products.length} product${
    products.length > 1 ? "s" : ""
  } found${lastRankingHint ? ` • ${lastRankingHint}` : ""}`;
}

function renderCart() {
  const list = document.getElementById("cartItems");
  const totalEl = document.getElementById("cartTotal");
  const countEl = document.getElementById("cartCount");
  const checkoutBtn = document.getElementById("checkoutBtn");
  if (!list || !totalEl || !countEl || !checkoutBtn) return;
  list.style.maxHeight = "none";
  list.style.overflow = "visible";
  list.style.display = "block";

  list.innerHTML = "";

  if (!cart.length) {
    list.innerHTML =
      '<li class="empty-state">Your cart is empty. Add items from the product list.</li>';
    totalEl.textContent = formatPrice(0);
    countEl.textContent = "0";
    checkoutBtn.disabled = true;
    renderPlacedOrders();
    renderWishlist();
    renderRecommendations();
    return;
  }

  let totalPrice = 0;
  let totalItems = 0;

  cart.forEach((entry) => {
    const normalizedId = normalizeProductId(entry.productId);
    const product = PRODUCTS.find((p) => p.id === normalizedId);
    if (!product) return;

    const itemTotal = product.price * entry.quantity;
    totalPrice += itemTotal;
    totalItems += entry.quantity;

    const li = document.createElement("li");
    li.className = "cart-item";
    const main = document.createElement("div");
    main.className = "cart-item-main";
    const title = document.createElement("span");
    title.className = "cart-item-title";
    title.textContent = product.name;
    const meta = document.createElement("div");
    meta.className = "cart-item-meta";
    const qty = document.createElement("span");
    qty.textContent = `${entry.quantity} × ${formatPrice(product.price)}`;
    meta.appendChild(qty);
    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement("div");
    const saveBtn = document.createElement("button");
    saveBtn.className = "cart-item-save";
    saveBtn.type = "button";
    saveBtn.textContent = "Save for later";
    const removeBtn = document.createElement("button");
    removeBtn.className = "cart-item-remove";
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    actions.appendChild(saveBtn);
    actions.appendChild(removeBtn);
    li.appendChild(main);
    li.appendChild(actions);

    list.appendChild(li);
    removeBtn.addEventListener("click", () => removeFromCart(product.id));
    saveBtn.addEventListener("click", () => moveCartItemToWishlist(product.id));
  });

  totalEl.textContent = formatPrice(totalPrice);
  countEl.textContent = totalItems.toString();
  checkoutBtn.disabled = false;
  renderPlacedOrders();
  renderWishlist();
  renderRecommendations();
}

function renderPlacedOrders() {
  const list = document.getElementById("placedOrdersList");
  if (!list) return;
  list.innerHTML = "";
  if (!placedOrders.length) {
    list.innerHTML = '<li class="empty-state">No orders placed yet.</li>';
    return;
  }
  placedOrders
    .slice()
    .reverse()
    .slice(0, 8)
    .forEach((order) => {
      const displayStatus = inferOrderStatus(order);
      const li = document.createElement("li");
      li.className = "placed-order-item";
      li.dataset.orderId = order.id;
      li.innerHTML = `
        <div class="placed-order-top">
          <span class="placed-order-id">#${escapeHtml(order.id || "NA")}</span>
          <span class="placed-order-status">${escapeHtml(displayStatus)}</span>
        </div>
        <div class="placed-order-meta">${escapeHtml(order.date || "")}</div>
        <div class="placed-order-meta">${escapeHtml(order.itemsSummary || "")}</div>
        <div class="placed-order-meta">Total: ${formatPrice(Number(order.total || 0))} • ETA ${
          order.etaDays || 4
        }d</div>
      `;
      list.appendChild(li);
    });
}

function findOrderById(orderId) {
  return placedOrders.find((o) => o.id === orderId);
}

function openOrderDetails(orderId) {
  const order = findOrderById(orderId);
  if (!order) return;
  currentOrderDetailsId = order.id;
  const modal = document.getElementById("orderDetailsModal");
  const meta = document.getElementById("orderDetailsMeta");
  const address = document.getElementById("orderDetailsAddress");
  const timeline = document.getElementById("orderDetailsTimeline");
  const items = document.getElementById("orderDetailsItems");
  const status = document.getElementById("orderActionStatus");
  const cancelBtn = document.getElementById("orderCancelBtn");
  const trackBtn = document.getElementById("orderTrackBtn");
  const reorderBtn = document.getElementById("orderReorderBtn");
  const returnBtn = document.getElementById("orderReturnBtn");
  const returnReasonSelect = document.getElementById("returnReasonSelect");
  const statusNow = inferOrderStatus(order);
  meta.textContent = `Order #${order.id} • ${order.date} • ${order.payment || "N/A"}`;
  address.textContent = order.address || "Address not available";
  items.innerHTML = "";
  (order.items || []).forEach((entry) => {
    const li = document.createElement("li");
    li.className = "cart-item";
    li.innerHTML = `<span>${escapeHtml(entry.name)} x${entry.quantity}</span><span>${formatPrice(
      entry.total
    )}</span>`;
    items.appendChild(li);
  });
  const timelineSteps =
    statusNow === "Cancelled"
      ? ["Order placed", "Cancelled", "Closed"]
      : statusNow === "Return Requested"
      ? ["Delivered", "Return requested", "Refund in progress"]
      : statusNow === "Refunded"
      ? ["Delivered", "Return approved", "Refunded"]
      : statusNow === "Delivered"
      ? ["Order placed", "Out for delivery", "Delivered"]
      : ["Order placed", "Packed", "Out for delivery"];
  timeline.innerHTML = timelineSteps
    .map(
      (s, i) =>
        `<span class="checkout-step ${i === 0 || order.status === "Cancelled" ? "active" : ""}">${escapeHtml(
          s
        )}</span>`
    )
    .join("");
  status.textContent = "";
  const canCancel =
    statusNow === "Placed" && Date.now() - Number(order.createdAt || 0) < 5 * 60 * 1000;
  cancelBtn.disabled = !canCancel;
  trackBtn.disabled = statusNow === "Cancelled";
  reorderBtn.disabled = false;
  returnBtn.disabled = statusNow !== "Delivered";
  returnReasonSelect.value = "";
  modal.classList.add("visible");
  modal.setAttribute("aria-hidden", "false");
}

function closeOrderDetails() {
  const modal = document.getElementById("orderDetailsModal");
  modal.classList.remove("visible");
  modal.setAttribute("aria-hidden", "true");
  currentOrderDetailsId = null;
}

function cancelCurrentOrder() {
  const order = findOrderById(currentOrderDetailsId);
  if (!order) return;
  order.status = "Cancelled";
  savePlacedOrders();
  renderPlacedOrders();
  openOrderDetails(order.id);
  const status = document.getElementById("orderActionStatus");
  status.textContent = "Order cancelled successfully.";
}

function trackCurrentOrder() {
  const order = findOrderById(currentOrderDetailsId);
  if (!order) return;
  const status = document.getElementById("orderActionStatus");
  const statusNow = inferOrderStatus(order);
  if (statusNow === "Cancelled") {
    status.textContent = "This order has been cancelled.";
    return;
  }
  if (statusNow === "Delivered") {
    status.textContent = "Package delivered successfully.";
    return;
  }
  status.textContent = `Package is in transit. Expected delivery in ${order.etaDays || 4} day(s).`;
}

function requestReturnCurrentOrder() {
  const order = findOrderById(currentOrderDetailsId);
  if (!order) return;
  const reason = document.getElementById("returnReasonSelect").value;
  const status = document.getElementById("orderActionStatus");
  if (inferOrderStatus(order) !== "Delivered") {
    status.textContent = "Return can be requested only after delivery.";
    return;
  }
  if (!reason) {
    status.textContent = "Please select a return reason.";
    return;
  }
  order.status = "Return Requested";
  order.returnReason = reason;
  savePlacedOrders();
  renderPlacedOrders();
  openOrderDetails(order.id);
  status.textContent = `Return requested: ${reason}. Refund will be processed in 2-4 days.`;
}

function reorderCurrentOrder() {
  const order = findOrderById(currentOrderDetailsId);
  if (!order || !Array.isArray(order.items)) return;
  order.items.forEach((entry) => {
    const product = PRODUCTS.find((p) => p.id === entry.productId);
    if (!product || product.stock <= 0) return;
    const existing = cart.find((c) => c.productId === product.id);
    if (existing) {
      existing.quantity = Math.min(existing.quantity + entry.quantity, product.stock);
    } else {
      cart.push({ productId: product.id, quantity: Math.min(entry.quantity, product.stock) });
    }
  });
  renderCart();
  closeOrderDetails();
}

// ── Taste Profile Visualisation ───────────────────────────────────
function renderTasteProfile() {
  const wrap = document.getElementById("tasteProfileWrap");
  const subtitle = document.getElementById("tasteProfileSubtitle");
  if (!wrap) return;

  const profile = getInteractionProfile();
  const catWeights = profile.categoryWeights;
  const brandWeights = profile.brandWeights;

  const totalEvents = recommenderHistory.events.length;
  if (totalEvents === 0) { wrap.hidden = true; return; }

  // Update subtitle
  if (subtitle) subtitle.textContent = `${totalEvents} interaction${totalEvents !== 1 ? "s" : ""} learned`;

  // Build sorted top-5 for categories and brands
  const topCats = Object.entries(catWeights)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 5);
  const topBrands = Object.entries(brandWeights)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 5);

  const maxCat = topCats.length ? Math.max(...topCats.map(([, v]) => Math.abs(v))) : 1;
  const maxBrand = topBrands.length ? Math.max(...topBrands.map(([, v]) => Math.abs(v))) : 1;

  function buildBars(entries, maxVal) {
    if (!entries.length) return "<p style='font-size:0.72rem;color:#94a3b8;padding:4px 0'>No data yet — browse some products!</p>";
    return entries.map(([key, val]) => {
      const pct = Math.round((Math.abs(val) / maxVal) * 100);
      const label = key.length > 14 ? key.slice(0, 13) + "…" : key;
      const isNeg = val < 0;
      const fillClass = isNeg ? "taste-bar-fill negative" : "taste-bar-fill";
      const displayLabel = formatCategoryLabel ? formatCategoryLabel(key) : key;
      const shortLabel = displayLabel.length > 14 ? displayLabel.slice(0, 13) + "…" : displayLabel;
      return `<div class="taste-bar-row">
        <span class="taste-bar-label" title="${escapeHtml(displayLabel)}">${escapeHtml(shortLabel)}</span>
        <div class="taste-bar-track"><div class="${fillClass}" style="width:${pct}%"></div></div>
        <span class="taste-bar-value">${pct}</span>
      </div>`;
    }).join("");
  }

  const catChart = document.getElementById("tasteChartCategories");
  const brandChart = document.getElementById("tasteChartBrands");
  if (catChart) catChart.innerHTML = buildBars(topCats, maxCat);
  if (brandChart) brandChart.innerHTML = buildBars(topBrands, maxBrand);

  // Respect whichever tab is currently active
  const activeTab = document.querySelector(".taste-tab.active");
  const activeWhich = activeTab ? activeTab.getAttribute("data-tab") : "categories";
  if (catChart) catChart.hidden = activeWhich !== "categories";
  if (brandChart) brandChart.hidden = activeWhich !== "brands";

  wrap.hidden = false;
}

function initTasteProfileTabs() {
  const tabs = document.querySelectorAll(".taste-tab");
  // Ensure correct initial state: categories visible, brands hidden
  const catChart = document.getElementById("tasteChartCategories");
  const brandChart = document.getElementById("tasteChartBrands");
  if (catChart) catChart.hidden = false;
  if (brandChart) brandChart.hidden = true;

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const which = tab.getAttribute("data-tab");
      const catChart = document.getElementById("tasteChartCategories");
      const brandChart = document.getElementById("tasteChartBrands");
      if (catChart) catChart.hidden = which !== "categories";
      if (brandChart) brandChart.hidden = which !== "brands";
    });
  });
}

function renderWishlist() {
  const list = document.getElementById("wishlistList");
  if (!list) return;
  list.innerHTML = "";
  if (!wishlist.length) {
    list.innerHTML = '<li class="empty-state">No saved items yet.</li>';
    return;
  }
  wishlist.slice(0, 10).forEach((id) => {
    const product = PRODUCTS.find((p) => p.id === id);
    if (!product) return;
    const li = document.createElement("li");
    li.className = "placed-order-item";
    li.innerHTML = `
      <div class="placed-order-top">
        <span class="placed-order-id">${escapeHtml(product.name)}</span>
        <span class="placed-order-status">${getStockLabel(product)}</span>
      </div>
      <div class="placed-order-meta">${formatPrice(product.price)} • ETA ${getDeliveryEstimateDays(
      product,
      document.getElementById("checkoutCity")?.value || ""
    )} days</div>
      <div class="compare-actions">
        <button type="button" class="compare-btn" data-wishlist-action="move" data-product-id="${
          product.id
        }">Move to cart</button>
        <button type="button" class="compare-btn secondary" data-wishlist-action="remove" data-product-id="${
          product.id
        }">Remove</button>
      </div>
    `;
    list.appendChild(li);
  });
}


function clearCheckoutTimers() {
  checkoutTimers.forEach((id) => clearTimeout(id));
  checkoutTimers = [];
}

function setCheckoutStep(stepKey) {
  document.querySelectorAll("#checkoutProgress .checkout-step").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-step") === stepKey);
  });
}

function getCartSummary() {
  const items = [];
  let total = 0;
  cart.forEach((entry) => {
    const product = PRODUCTS.find((p) => p.id === entry.productId);
    if (!product) return;
    const itemTotal = product.price * entry.quantity;
    total += itemTotal;
    items.push({ product, quantity: entry.quantity, itemTotal });
  });
  return { items, total };
}

function renderCheckoutSummary() {
  const list = document.getElementById("checkoutItems");
  const totalEl = document.getElementById("checkoutTotal");
  if (!list || !totalEl) return;
  const { items, total } = getCartSummary();
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = '<li class="empty-state">No items in cart.</li>';
    totalEl.textContent = formatPrice(0);
    return;
  }
  items.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "cart-item";
    li.innerHTML = `
      <div class="cart-item-main">
        <span class="cart-item-title">${entry.product.name}</span>
        <div class="cart-item-meta">
          <span>${entry.quantity} × ${formatPrice(entry.product.price)}</span>
        </div>
      </div>
      <span>${formatPrice(entry.itemTotal)}</span>
    `;
    list.appendChild(li);
  });
  totalEl.textContent = formatPrice(total);
}

function openCheckoutModal() {
  if (!cart.length) return;
  const modal = document.getElementById("checkoutModal");
  const status = document.getElementById("checkoutStatus");
  const placeOrderBtn = document.getElementById("placeOrderBtn");
  checkoutInProgress = false;
  clearCheckoutTimers();
  renderCheckoutSummary();
  setCheckoutStep("details");
  if (status) status.textContent = "";
  clearCheckoutValidation();
  if (placeOrderBtn) {
    placeOrderBtn.disabled = false;
    placeOrderBtn.textContent = "Place order";
    placeOrderBtn.dataset.state = "ready";
  }
  modal.classList.add("visible");
  modal.setAttribute("aria-hidden", "false");
}

function closeCheckoutModal() {
  if (checkoutInProgress) return;
  const modal = document.getElementById("checkoutModal");
  modal.classList.remove("visible");
  modal.setAttribute("aria-hidden", "true");
  clearCheckoutTimers();
}

function clearCheckoutValidation() {
  ["checkoutName", "checkoutPhone", "checkoutAddress", "checkoutCity", "checkoutPincode"].forEach(
    (id) => {
      const input = document.getElementById(id);
      const err = document.getElementById(`${id}Error`);
      if (input) input.classList.remove("input-invalid");
      if (err) err.textContent = "";
    }
  );
}

function setCheckoutFieldError(id, message) {
  const input = document.getElementById(id);
  const err = document.getElementById(`${id}Error`);
  if (input) input.classList.add("input-invalid");
  if (err) err.textContent = message;
}

function validateCheckoutForm() {
  clearCheckoutValidation();
  const values = {
    checkoutName: document.getElementById("checkoutName").value.trim(),
    checkoutPhone: document.getElementById("checkoutPhone").value.trim(),
    checkoutAddress: document.getElementById("checkoutAddress").value.trim(),
    checkoutCity: document.getElementById("checkoutCity").value.trim(),
    checkoutPincode: document.getElementById("checkoutPincode").value.trim(),
  };

  let valid = true;
  if (values.checkoutName.length < 3 || !/^[a-zA-Z\s.'-]+$/.test(values.checkoutName)) {
    setCheckoutFieldError("checkoutName", "Enter a valid full name.");
    valid = false;
  }
  if (!/^\d{10}$/.test(values.checkoutPhone)) {
    setCheckoutFieldError("checkoutPhone", "Phone must be exactly 10 digits.");
    valid = false;
  }
  if (values.checkoutAddress.length < 10) {
    setCheckoutFieldError("checkoutAddress", "Address must be at least 10 characters.");
    valid = false;
  }
  if (values.checkoutCity.length < 2 || !/^[a-zA-Z\s.-]+$/.test(values.checkoutCity)) {
    setCheckoutFieldError("checkoutCity", "Enter a valid city name.");
    valid = false;
  }
  if (!/^\d{6}$/.test(values.checkoutPincode)) {
    setCheckoutFieldError("checkoutPincode", "Pincode must be 6 digits.");
    valid = false;
  }
  return valid;
}

function startCheckoutProcess() {
  const payment = document.getElementById("checkoutPayment").value;
  const status = document.getElementById("checkoutStatus");
  const placeOrderBtn = document.getElementById("placeOrderBtn");
  if (!validateCheckoutForm()) {
    status.textContent = "Please fix the highlighted checkout fields.";
    return;
  }
  checkoutInProgress = true;
  placeOrderBtn.disabled = true;
  setCheckoutStep("payment");
  status.textContent = `Validating details and ${payment.toUpperCase()} payment...`;
  clearCheckoutTimers();
  checkoutTimers.push(
    setTimeout(() => {
      status.textContent = "Payment authorized. Preparing shipment...";
      setCheckoutStep("confirm");
    }, 1300)
  );
  checkoutTimers.push(
    setTimeout(() => {
      const orderId = `SE${Math.floor(Math.random() * 900000 + 100000)}`;
      const { items, total } = getCartSummary();
      const fullName = document.getElementById("checkoutName").value.trim();
      const phone = document.getElementById("checkoutPhone").value.trim();
      const addressLine = document.getElementById("checkoutAddress").value.trim();
      const city = document.getElementById("checkoutCity").value.trim();
      const pincode = document.getElementById("checkoutPincode").value.trim();
      const etaDays = items.length
        ? Math.max(
            ...items.map((entry) => getDeliveryEstimateDays(entry.product, city))
          )
        : 4;
      const itemsSummary = items
        .slice(0, 2)
        .map((entry) => `${entry.product.name} x${entry.quantity}`)
        .join(", ");
      placedOrders.push({
        id: orderId,
        status: "Placed",
        total,
        date: new Date().toLocaleString("en-IN"),
        createdAt: Date.now(),
        payment,
        address: `${fullName}, ${phone}, ${addressLine}, ${city} - ${pincode}`,
        etaDays,
        items: items.map((entry) => ({
          productId: entry.product.id,
          name: entry.product.name,
          quantity: entry.quantity,
          total: entry.itemTotal,
        })),
        itemsSummary:
          items.length > 2
            ? `${itemsSummary}, +${items.length - 2} more`
            : itemsSummary,
      });
      savePlacedOrders();
      status.textContent = `Order placed successfully! Order ID: ${orderId}. Estimated delivery: ${etaDays} day(s).`;
      cart.splice(0, cart.length);
      renderCart();
      applyFilters();
      checkoutInProgress = false;
      placeOrderBtn.disabled = false;
      placeOrderBtn.textContent = "Placed! Close";
      placeOrderBtn.dataset.state = "done";
    }, 2800)
  );
}

function getEventBaseWeight(type) {
  if (type === "cart")             return 3;
  if (type === "wishlist_save")    return 2.5;
  if (type === "compare")          return 2;
  if (type === "search_click")     return 1.25;
  if (type === "view")             return 1;
  if (type === "wishlist_remove")  return -1;
  if (type === "not_interested")   return -3;
  return 1;
}

function getInteractionProfile() {
  const productWeights = {};
  const categoryWeights = {};
  const brandWeights = {};
  const now = Date.now();

  recommenderHistory.events.forEach((event) => {
    const product = PRODUCTS.find((p) => p.id === event.productId);
    if (!product) return;
    const ageDays = Math.max(0, (now - Number(event.ts || now)) / (1000 * 60 * 60 * 24));
    const recency = Math.exp(-ageDays / 14);
    const w = getEventBaseWeight(event.type) * recency;
    productWeights[product.id] = (productWeights[product.id] || 0) + w;
    categoryWeights[product.category] = (categoryWeights[product.category] || 0) + w;
    if (product.brand) {
      const key = String(product.brand).toLowerCase();
      brandWeights[key] = (brandWeights[key] || 0) + w;
    }
  });

  return { productWeights, categoryWeights, brandWeights };
}

function getRecentSessionEvents(limit = SESSION_SIGNAL_WINDOW) {
  return recommenderHistory.events
    .filter((event) => Number(event.ts || 0) >= sessionStartTs)
    .slice(-limit);
}

function getSessionBoost(candidate, recentEvents) {
  if (!recentEvents.length) return 0;
  let boost = 0;
  recentEvents.forEach((event, i) => {
    const source = PRODUCTS.find((p) => p.id === event.productId);
    if (!source) return;
    const freshness = (i + 1) / recentEvents.length;
    const eventWeight = getEventBaseWeight(event.type) * freshness;
    if (source.id === candidate.id) boost += 0.15 * eventWeight;
    if (source.category === candidate.category) boost += 0.2 * eventWeight;
    if (
      source.brand &&
      candidate.brand &&
      String(source.brand).toLowerCase() === String(candidate.brand).toLowerCase()
    ) {
      boost += 0.1 * eventWeight;
    }
  });
  return Math.min(1, boost / 3);
}

function getContentSignal(candidate, profile) {
  if (!SEARCH_MODEL) return { score: 0, seedId: null };
  const candVec = SEARCH_MODEL.docVectorsById.get(candidate.id);
  const candNorm = SEARCH_MODEL.docNormsById.get(candidate.id);
  if (!candVec || !candNorm) return { score: 0, seedId: null };
  let best = 0;
  let bestSeedId = null;
  Object.keys(profile.productWeights).forEach((seedId) => {
    const seedWeight = profile.productWeights[seedId];
    if (!seedWeight) return;
    const seedVec = SEARCH_MODEL.docVectorsById.get(seedId);
    const seedNorm = SEARCH_MODEL.docNormsById.get(seedId);
    if (!seedVec || !seedNorm) return;
    const sim = cosineSimilaritySparse(seedVec, seedNorm, candVec, candNorm);
    const weighted = sim * Math.min(1, seedWeight / 3);
    if (weighted > best) {
      best = weighted;
      bestSeedId = seedId;
    }
  });
  return { score: best, seedId: bestSeedId };
}

function getBehaviorScore(candidate, profile) {
  const cat = profile.categoryWeights[candidate.category] || 0;
  const brand = candidate.brand
    ? profile.brandWeights[String(candidate.brand).toLowerCase()] || 0
    : 0;
  return Math.min(1, cat / 6) * 0.7 + Math.min(1, brand / 4) * 0.3;
}

function getRecommendationReason(candidate, seedId, recentEvents) {
  if (seedId) {
    const seed = PRODUCTS.find((p) => p.id === seedId);
    if (seed) return `Because you viewed ${seed.name}`;
  }
  for (let i = recentEvents.length - 1; i >= 0; i -= 1) {
    const event = recentEvents[i];
    const source = PRODUCTS.find((p) => p.id === event.productId);
    if (!source) continue;
    if (source.category === candidate.category) {
      return `Because you viewed ${source.name}`;
    }
  }
  return `Because you like ${formatCategoryLabel(candidate.category)}`;
}

function getTrendingProducts(limit = 6) {
  return PRODUCTS
    .slice()
    .sort((a, b) => b.rating - a.rating || a.price - b.price)
    .slice(0, limit);
}

function pickDiverseProducts(scored, limit = 6) {
  const chosen = [];
  const categoryCounts = {};
  const maxPerCategory = recommendationDiversity >= 70 ? 1 : recommendationDiversity >= 40 ? 2 : 3;
  for (const entry of scored) {
    if (chosen.length >= limit) break;
    const cat = entry.product.category || "other";
    if ((categoryCounts[cat] || 0) >= maxPerCategory && scored.length > limit) continue;
    chosen.push(entry.product);
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  }
  return chosen;
}

function renderRecommendations() {
  const wrap = document.getElementById("recommendationsWrap");
  const row = document.getElementById("recommendationsRow");
  const reasonEl = document.getElementById("recommendationsReason");

  if (!wrap || !row) return;

  row.innerHTML = "";

  const activeCategory =
    categoryFilterValue !== "all" ? categoryFilterValue : activeCategoryShortcut;
  const cartProductIds = new Set(cart.map((entry) => entry.productId));
  const profile = getInteractionProfile();
  const recentSessionEvents = getRecentSessionEvents();
  const hasHistory = Object.keys(profile.productWeights).length > 0;
  let topWithReasons = [];

  if (!hasHistory) {
    topWithReasons = getTrendingProducts(6)
      .filter(
        (p) =>
          !cartProductIds.has(p.id) &&
          (activeCategory === "all" || p.category === activeCategory)
      )
      .filter((p) => !isHiddenByFeedback(p))
      .map((product) => ({
        product,
        reason: `Trending in ${formatCategoryLabel(product.category)}`,
      }));
    if (reasonEl) {
      reasonEl.textContent = "Trending now (cold start until we learn your preferences)";
    }
  } else {
    const diversityFactor = recommendationDiversity / 100;
    const contentWeight = 0.7 - diversityFactor * 0.35;
    const behaviorWeight = 0.45 - diversityFactor * 0.15;
    const sessionWeight = SESSION_BOOST_WEIGHT + diversityFactor * 0.2;
    const scored = PRODUCTS
      .filter((p) => !cartProductIds.has(p.id))
      .filter((p) => activeCategory === "all" || p.category === activeCategory)
      .filter((p) => !isHiddenByFeedback(p))
      .map((product) => {
        const contentSignal = getContentSignal(product, profile);
        const behaviorScore = getBehaviorScore(product, profile);
        const sessionBoost = getSessionBoost(product, recentSessionEvents);
        const ratingScore = product.rating / 5;

        // DL score: blend in neural autoencoder score when ready (weight 0.4)
        const dlScore = (window.DL_RECOMMENDER && window.DL_RECOMMENDER.ready)
          ? window.DL_RECOMMENDER.getScore(product.id)
          : 0;
        const dlWeight = (window.DL_RECOMMENDER && window.DL_RECOMMENDER.ready) ? 0.4 : 0;
        const heuristicScale = dlWeight > 0 ? 0.6 : 1.0;

        const score =
          (contentSignal.score * contentWeight +
          behaviorScore * behaviorWeight +
          ratingScore * 0.05 +
          sessionBoost * sessionWeight) * heuristicScale +
          dlScore * dlWeight;

        const reason = getRecommendationReason(
          product,
          contentSignal.seedId,
          recentSessionEvents
        );
        return { product, score, reason };
      })
      .sort((a, b) => b.score - a.score || b.product.rating - a.product.rating);
    const chosenIds = new Set(pickDiverseProducts(scored, 6).map((p) => p.id));
    topWithReasons = scored.filter((entry) => chosenIds.has(entry.product.id)).slice(0, 6);
    if (reasonEl) {
      const dlReady = window.DL_RECOMMENDER && window.DL_RECOMMENDER.ready;
      reasonEl.textContent = dlReady
        ? "Personalised using your browsing and save history"
        : recentSessionEvents.length
          ? "Adapted to your latest browsing in this session"
          : "Based on your views, cart actions, and similar products";
    }
  }

  if (!topWithReasons.length) {
    wrap.hidden = true;
    if (reasonEl) reasonEl.textContent = "";
    return;
  }

  topWithReasons.forEach(({ product, reason }) => {
    row.appendChild(
      createProductCard(product, {
        recommended: true,
        recommendationReason: reason,
      })
    );
  });
  wrap.hidden = false;
}

function renderSimilarItems(productId) {
  const wrap = document.getElementById("similarWrap");
  const row = document.getElementById("similarRow");
  if (!wrap || !row || !SEARCH_MODEL) return;

  const current = PRODUCTS.find((p) => p.id === productId);
  if (!current) {
    wrap.hidden = true;
    row.innerHTML = "";
    return;
  }

  const currentVec = SEARCH_MODEL.docVectorsById.get(current.id);
  const currentNorm = SEARCH_MODEL.docNormsById.get(current.id);
  if (!currentVec || !currentNorm) {
    wrap.hidden = true;
    row.innerHTML = "";
    return;
  }

  const profile = getInteractionProfile();
  const recentSessionEvents = getRecentSessionEvents();
  const scored = PRODUCTS
    .filter((p) => p.id !== current.id)
    .filter((p) => !isHiddenByFeedback(p))
    .map((candidate) => {
      const candVec = SEARCH_MODEL.docVectorsById.get(candidate.id);
      const candNorm = SEARCH_MODEL.docNormsById.get(candidate.id);
      const similarScore = cosineSimilaritySparse(currentVec, currentNorm, candVec, candNorm);
      const behaviorScore = getBehaviorScore(candidate, profile);
      const sessionBoost = getSessionBoost(candidate, recentSessionEvents);
      const score =
        similarScore * 0.7 +
        behaviorScore * 0.2 +
        (candidate.rating / 5) * 0.1 +
        sessionBoost * 0.2;
      const reason = `Because you viewed ${current.name}`;
      return { product: candidate, score, reason };
    })
    .sort((a, b) => b.score - a.score || b.product.rating - a.product.rating);

  const chosenIds = new Set(pickDiverseProducts(scored, 4).map((p) => p.id));
  const top = scored.filter((entry) => chosenIds.has(entry.product.id)).slice(0, 4);
  row.innerHTML = "";
  top.forEach(({ product, reason }) => {
    row.appendChild(
      createProductCard(product, {
        recommended: true,
        recommendationReason: reason,
      })
    );
  });
  wrap.hidden = top.length === 0;
}

function applyFilters() {
  const lowerQuery = (parsedIntentQuery || searchQuery).trim().toLowerCase();
  activeSearchTokens = tokenizeForSearch(lowerQuery);

  // Category from either the top row or the select
  const categoryToApply =
    categoryFilterValue !== "all" ? categoryFilterValue : activeCategoryShortcut;
  const personalizationEnabled = personalizationToggleOn && categoryToApply === "all";

  // Base filtering (everything except semantic search ranking)
  const filteredBase = PRODUCTS.filter((product) => {
    if (categoryToApply !== "all" && product.category !== categoryToApply) {
      return false;
    }

    // Price range filter
    if (priceFilterValue !== "all") {
      const [min, max] = priceFilterValue.split("-").map(Number);
      if (product.price < min || product.price > max) return false;
    }

    // Rating filter
    if (ratingFilterValue !== "all") {
      const minRating = Number(ratingFilterValue);
      if (product.rating < minRating) return false;
    }

    // Stock filter
    if (stockFilterValue === "in" && Number(product.stock || 0) <= 0) {
      return false;
    }
    if (stockFilterValue === "out" && Number(product.stock || 0) > 0) {
      return false;
    }

    return true;
  });

  // If there is no query, just show base results (nicely ordered).
  if (!lowerQuery) {
    const sorted = filteredBase
      .slice()
      .map((product) => ({
        product,
        score:
          product.rating +
          (personalizationEnabled ? getPersonalizationBoost(product) : 0),
      }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.product);
    lastRankingHint = personalizationEnabled
      ? "Ranked by rating + your browsing behavior"
      : `Ranked within ${formatCategoryLabel(categoryToApply)}`;
    renderProducts(sorted);
    renderRecommendations();
    return;
  }

  const queryTokens = activeSearchTokens;
  if (!queryTokens.length) {
    lastRankingHint = "";
    renderProducts([]);
    renderRecommendations();
    return;
  }

  const { vec: queryVec, norm: queryNorm } = vectorizeQueryTokens(queryTokens);

  const scored = filteredBase
    .map((product) => {
      const docVec = SEARCH_MODEL.docVectorsById.get(product.id);
      const docNorm = SEARCH_MODEL.docNormsById.get(product.id);
      const score = cosineSimilaritySparse(
        queryVec,
        queryNorm,
        docVec,
        docNorm
      ) + (personalizationEnabled ? getPersonalizationBoost(product) : 0);
      return { product, score };
    })
    .sort(
      (a, b) => b.score - a.score || b.product.rating - a.product.rating
    );

  const semanticFiltered = scored.filter((x) => x.score > 0).map((x) => x.product);

  if (!semanticFiltered.length) {
    lastRankingHint = "";
    renderProducts([]);
    renderRecommendations();
    return;
  }

  const reasonProduct = semanticFiltered[0];
  const personalReason = getPersonalizationReason(reasonProduct);
  if (!personalizationEnabled) {
    lastRankingHint = `Ranked by semantic similarity in ${formatCategoryLabel(
      categoryToApply
    )}`;
  } else {
    lastRankingHint = personalReason || "Ranked by semantic similarity";
  }
  renderProducts(semanticFiltered);
  renderRecommendations();
}

function clearFilters() {
  const searchInput = document.getElementById("searchInput");
  const priceSelect = document.getElementById("priceFilter");
  const ratingSelect = document.getElementById("ratingFilter");
  const categorySelect = document.getElementById("categoryFilter");
  const stockSelect = document.getElementById("stockFilter");

  searchQuery = "";
  parsedIntentQuery = "";
  priceFilterValue = "all";
  ratingFilterValue = "all";
  categoryFilterValue = "all";
  stockFilterValue = "all";
  activeCategoryShortcut = "all";

  searchInput.value = "";
  priceSelect.value = "all";
  ratingSelect.value = "all";
  categorySelect.value = "all";
  if (stockSelect) stockSelect.value = "all";

  // Update active state of top category buttons
  document.querySelectorAll(".category-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.category === "all");
  });

  applyFilters();
}

function openProductModal(productId) {
  const product = PRODUCTS.find((p) => p.id === productId);
  if (!product) return;
  trackProductInteraction(product, "view");
  recordInteraction(product.id, "view");

  currentModalProductId = product.id;

  const modal = document.getElementById("productModal");
  const img = document.getElementById("modalImage");
  const title = document.getElementById("modalTitle");
  const category = document.getElementById("modalCategory");
  const description = document.getElementById("modalDescription");
  const rating = document.getElementById("modalRating");
  const price = document.getElementById("modalPrice");
  const saveBtn = document.getElementById("saveToWishlistBtn");

  img.src =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='160'>
         <rect width='100%' height='100%' rx='20' ry='20' fill='#e5edff'/>
         <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='46'>${product.emoji}</text>
       </svg>`
    );
  title.textContent = product.name;
  category.textContent = `Category: ${formatCategoryLabel(product.category)}`;
  description.textContent = product.description;
  rating.textContent = `${product.rating.toFixed(1)}★ rating`;
  price.textContent = formatPrice(product.price);
  if (saveBtn) {
    saveBtn.textContent = wishlist.includes(product.id) ? "Saved" : "Save";
  }
  renderSimilarItems(product.id);

  modal.classList.add("visible");
  modal.setAttribute("aria-hidden", "false");
}

function closeProductModal() {
  const modal = document.getElementById("productModal");
  const similarWrap = document.getElementById("similarWrap");
  const similarRow = document.getElementById("similarRow");
  modal.classList.remove("visible");
  modal.setAttribute("aria-hidden", "true");
  if (similarRow) similarRow.innerHTML = "";
  if (similarWrap) similarWrap.hidden = true;
  currentModalProductId = null;
}

function addToCart(productId) {
  const normalizedId = normalizeProductId(productId);
  const productExists = PRODUCTS.some((p) => p.id === normalizedId);
  if (!productExists) return;
  const product = PRODUCTS.find((p) => p.id === normalizedId);
  if (product && product.stock <= 0) return;

  const existing = cart.find((entry) => entry.productId === normalizedId);
  if (existing) {
    if (product && existing.quantity >= product.stock) return;
    existing.quantity += 1;
  } else {
    cart.push({ productId: normalizedId, quantity: 1 });
  }
  if (product) trackProductInteraction(product, "add");
  if (product) recordInteraction(product.id, "cart");
  const wIdx = wishlist.indexOf(normalizedId);
  if (wIdx >= 0) {
    wishlist.splice(wIdx, 1);
    saveWishlist();
  }

  renderCart();
  renderWishlist();
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function priceBandFromUpperBound(num) {
  if (num <= 999) return "0-999";
  if (num <= 4999) return "1000-4999";
  if (num <= 9999) return "5000-9999";
  return "10000-999999";
}

function parseIntentQuery(query) {
  const q = query.toLowerCase();
  let working = q;
  const out = { category: null, price: null, rating: null, residualQuery: query };

  const catHit = [...categoryLabelsBySlug.entries()].find(([slug, label]) => {
    const labelLower = label.toLowerCase();
    return (
      working.includes(labelLower) ||
      working.includes(slug.replaceAll("-", " ")) ||
      working.includes(slug)
    );
  });
  if (catHit) {
    out.category = catHit[0];
    working = working.replace(catHit[1].toLowerCase(), " ");
    working = working.replace(catHit[0].replaceAll("-", " "), " ");
    working = working.replace(catHit[0], " ");
  }

  const under = working.match(/(?:under|below|less than)\s*₹?\s*(\d{2,6})/i);
  if (under) {
    const n = Number(under[1]);
    if (!Number.isNaN(n)) out.price = priceBandFromUpperBound(n);
    working = working.replace(under[0], " ");
  } else if (/\b(cheap|budget|affordable)\b/i.test(working)) {
    out.price = "0-999";
    working = working.replace(/\b(cheap|budget|affordable)\b/gi, " ");
  } else if (/\b(premium|luxury|high end)\b/i.test(working)) {
    out.price = "10000-999999";
    working = working.replace(/\b(premium|luxury|high end)\b/gi, " ");
  }

  const rating1 = working.match(
    /(?:above|over|at least|min(?:imum)?)\s*(\d(?:\.\d)?)\s*\*?\s*(?:star|stars)?/i
  );
  const rating2 = working.match(/(\d(?:\.\d)?)\s*\+?\s*(?:star|stars)/i);
  const hit = rating1 || rating2;
  if (hit) {
    const r = Number(hit[1]);
    if (!Number.isNaN(r)) out.rating = String(Math.max(2, Math.min(5, Math.floor(r))));
    working = working.replace(hit[0], " ");
  }

  out.residualQuery = working.replace(/\s+/g, " ").trim();
  return out;
}

function applyIntentFromQuery(query) {
  const parsed = parseIntentQuery(query);
  parsedIntentQuery = parsed.residualQuery;
  const priceSelect = document.getElementById("priceFilter");
  const ratingSelect = document.getElementById("ratingFilter");
  const categorySelect = document.getElementById("categoryFilter");
  const stockSelect = document.getElementById("stockFilter");

  if (parsed.price && priceSelect) {
    priceFilterValue = parsed.price;
    priceSelect.value = parsed.price;
  }
  if (parsed.rating && ratingSelect) {
    ratingFilterValue = parsed.rating;
    ratingSelect.value = parsed.rating;
  }
  if (parsed.category && categorySelect) {
    categoryFilterValue = parsed.category;
    activeCategoryShortcut = parsed.category;
    categorySelect.value = parsed.category;
    document.querySelectorAll("#categoryNav .category-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.category === parsed.category);
    });
  }
}

function getSearchSuggestions(query) {
  const q = query.trim().toLowerCase();
  if (!q || q.length < 2) return [];
  const candidates = new Set();
  PRODUCTS.forEach((p) => {
    candidates.add(p.name);
    if (p.brand) candidates.add(p.brand);
    const label = p.categoryLabel || formatCategoryLabel(p.category);
    candidates.add(label);
    label.split(/\s+/).forEach((w) => {
      if (w.length > 2) candidates.add(w);
    });
  });
  const starts = [];
  const typos = [];
  candidates.forEach((text) => {
    const lower = String(text).toLowerCase();
    if (lower.startsWith(q)) starts.push(text);
    else {
      const first = lower.split(/\s+/)[0] || lower;
      if (Math.abs(first.length - q.length) <= 2 && levenshteinDistance(first, q) <= 2) {
        typos.push(text);
      }
    }
  });
  return [...starts, ...typos].slice(0, 6);
}

function renderSearchSuggestions(query) {
  const box = document.getElementById("searchSuggestions");
  if (!box) return;
  const suggestions = getSearchSuggestions(query);
  if (!suggestions.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.innerHTML = suggestions
    .map((s) => `<button type="button" data-suggestion="${escapeHtml(s)}">${highlightText(s, tokenizeForSearch(query))}</button>`)
    .join("");
  box.hidden = false;
}

function removeFromCart(productId) {
  const index = cart.findIndex((entry) => entry.productId === productId);
  if (index !== -1) {
    cart.splice(index, 1);
    renderCart();
  }
}

function toggleWishlist(productId) {
  const normalizedId = normalizeProductId(productId);
  const idx = wishlist.indexOf(normalizedId);
  if (idx >= 0) {
    wishlist.splice(idx, 1);
    recordInteraction(normalizedId, "wishlist_remove");
  } else {
    wishlist.push(normalizedId);
    recordInteraction(normalizedId, "wishlist_save");
  }
  saveWishlist();
  renderWishlist();
  applyFilters();
}

function moveCartItemToWishlist(productId) {
  const normalizedId = normalizeProductId(productId);
  const cIdx = cart.findIndex((entry) => entry.productId === normalizedId);
  if (cIdx >= 0) cart.splice(cIdx, 1);
  if (!wishlist.includes(normalizedId)) {
    wishlist.push(normalizedId);
    recordInteraction(normalizedId, "wishlist_save");
  }
  saveWishlist();
  renderCart();
  renderWishlist();
}

async function init() {
  try {
    try {
      await loadProducts();
    } catch (err) {
      console.error(err);
      showCatalogLoadError(
        "Could not load the catalog. Use products.embed.js + index.html, or run: python3 -m http.server 8080 and open http://localhost:8080."
      );
      return;
    }

    initializeProductRuntimeData();
    rebuildCategoryLabelsMap();
    buildCategoryNavAndFilter();
    loadUserProfile();
    loadPersonalizationToggle();
    loadRecommenderHistory();
    loadRecommenderFeedback();
    loadPlacedOrders();
    loadWishlist();
    renderHiddenRecoManager();
    initTasteProfileTabs();
    renderTasteProfile();

    SEARCH_MODEL = null;
    buildSearchModel();

    // ── DL Recommender: train neural model on existing history ──
    if (window.DL_RECOMMENDER && typeof window.DL_RECOMMENDER.init === "function") {
      window.DL_RECOMMENDER.init(recommenderHistory.events, PRODUCTS).catch(console.warn);
    }

  // Search bar: live filtering as the user types
  const searchInput = document.getElementById("searchInput");
  searchInput.addEventListener("input", (event) => {
    searchQuery = event.target.value;
    applyIntentFromQuery(searchQuery);
    renderSearchSuggestions(searchQuery);
    applyFilters();
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const first = document.querySelector("#searchSuggestions button");
      if (first) {
        event.preventDefault();
        searchInput.value = first.getAttribute("data-suggestion");
        searchQuery = searchInput.value;
        applyIntentFromQuery(searchQuery);
        document.getElementById("searchSuggestions").hidden = true;
        applyFilters();
      }
    }
  });
  document.getElementById("searchSuggestions").addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-suggestion]");
    if (!btn) return;
    searchInput.value = btn.getAttribute("data-suggestion");
    searchQuery = searchInput.value;
    const firstMatch = PRODUCTS.find((p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
    if (firstMatch) recordInteraction(firstMatch.id, "search_click");
    applyIntentFromQuery(searchQuery);
    document.getElementById("searchSuggestions").hidden = true;
    applyFilters();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".search-wrapper")) {
      document.getElementById("searchSuggestions").hidden = true;
    }
  });

  // Filter dropdowns
  const priceSelect = document.getElementById("priceFilter");
  const ratingSelect = document.getElementById("ratingFilter");
  const categorySelect = document.getElementById("categoryFilter");
  const stockSelect = document.getElementById("stockFilter");
  const personalizeToggle = document.getElementById("personalizeToggle");
  const recoDiversityRange = document.getElementById("recoDiversityRange");
  const recoStyleHint = document.getElementById("recoStyleHint");
  if (personalizeToggle) {
    personalizeToggle.checked = personalizationToggleOn;
    personalizeToggle.addEventListener("change", (event) => {
      personalizationToggleOn = event.target.checked;
      savePersonalizationToggle();
      applyFilters();
    });
  }
  if (recoDiversityRange) {
    recoDiversityRange.value = String(recommendationDiversity);
    recoDiversityRange.addEventListener("input", (event) => {
      recommendationDiversity = Number(event.target.value || 35);
      if (recoStyleHint) {
        recoStyleHint.textContent =
          recommendationDiversity >= 60
            ? "More diverse recommendations"
            : "More liked items";
      }
      applyFilters();
    });
  }

  priceSelect.addEventListener("change", (event) => {
    priceFilterValue = event.target.value;
    applyFilters();
  });

  ratingSelect.addEventListener("change", (event) => {
    ratingFilterValue = event.target.value;
    applyFilters();
  });

  if (stockSelect) {
    stockSelect.addEventListener("change", (event) => {
      stockFilterValue = event.target.value;
      applyFilters();
    });
  }

  categorySelect.addEventListener("change", (event) => {
    const v = event.target.value;
    categoryFilterValue = v;
    activeCategoryShortcut = v;
    document.querySelectorAll("#categoryNav .category-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.category === v);
    });
    applyFilters();
  });

  // Clear filters button
  const clearFiltersBtn = document.getElementById("clearFiltersBtn");
  clearFiltersBtn.addEventListener("click", clearFilters);
  const hiddenRecoList = document.getElementById("hiddenRecoList");
  const clearHiddenRecoBtn = document.getElementById("clearHiddenRecoBtn");
  if (hiddenRecoList) {
    hiddenRecoList.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-unhide-type]");
      if (!btn) return;
      unhideFeedbackEntry(
        btn.getAttribute("data-unhide-type"),
        btn.getAttribute("data-unhide-key")
      );
    });
  }
  if (clearHiddenRecoBtn) {
    clearHiddenRecoBtn.addEventListener("click", clearAllHiddenFeedback);
  }
  ["checkoutName", "checkoutPhone", "checkoutAddress", "checkoutCity", "checkoutPincode"].forEach(
    (id) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener("input", () => {
        input.classList.remove("input-invalid");
        const err = document.getElementById(`${id}Error`);
        if (err) err.textContent = "";
      });
    }
  );

  document.getElementById("categoryNav").addEventListener("click", (e) => {
    const btn = e.target.closest(".category-btn");
    if (!btn) return;
    const cat = btn.dataset.category;
    activeCategoryShortcut = cat;
    categoryFilterValue = cat;
    categorySelect.value = cat;
    document.querySelectorAll("#categoryNav .category-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    applyFilters();
  });

  // Modal close behaviours
  const modal = document.getElementById("productModal");
  const modalCloseBtn = document.getElementById("modalCloseBtn");
  const addToCartBtn = document.getElementById("addToCartBtn");
  const compareOpenBtn = document.getElementById("compareOpenBtn");
  const compareClearBtn = document.getElementById("compareClearBtn");
  const compareModal = document.getElementById("compareModal");
  const compareCloseBtn = document.getElementById("compareCloseBtn");
  const checkoutBtn = document.getElementById("checkoutBtn");
  const checkoutModal = document.getElementById("checkoutModal");
  const checkoutCloseBtn = document.getElementById("checkoutCloseBtn");
  const placeOrderBtn = document.getElementById("placeOrderBtn");
  const saveToWishlistBtn = document.getElementById("saveToWishlistBtn");
  const orderDetailsModal = document.getElementById("orderDetailsModal");
  const orderDetailsCloseBtn = document.getElementById("orderDetailsCloseBtn");
  const orderCancelBtn = document.getElementById("orderCancelBtn");
  const orderTrackBtn = document.getElementById("orderTrackBtn");
  const orderReorderBtn = document.getElementById("orderReorderBtn");
  const orderReturnBtn = document.getElementById("orderReturnBtn");
  const placedOrdersList = document.getElementById("placedOrdersList");
  const wishlistList = document.getElementById("wishlistList");

  if (modalCloseBtn) modalCloseBtn.addEventListener("click", closeProductModal);

  if (modal) modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeProductModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeProductModal();
      closeCheckoutModal();
      closeOrderDetails();
    }
  });

  // Add-to-cart from the modal
  if (addToCartBtn) addToCartBtn.addEventListener("click", () => {
    if (currentModalProductId != null) {
      addToCart(currentModalProductId);
    }
  });
  if (saveToWishlistBtn) saveToWishlistBtn.addEventListener("click", () => {
    if (currentModalProductId == null) return;
    toggleWishlist(currentModalProductId);
    const saved = wishlist.includes(currentModalProductId);
    saveToWishlistBtn.textContent = saved ? "Saved" : "Save";
  });

  if (compareOpenBtn) compareOpenBtn.addEventListener("click", () => {
    renderCompareTable();
    if (compareModal) {
      compareModal.classList.add("visible");
      compareModal.setAttribute("aria-hidden", "false");
    }
  });
  if (compareClearBtn) compareClearBtn.addEventListener("click", clearCompare);
  if (compareCloseBtn) compareCloseBtn.addEventListener("click", () => {
    if (!compareModal) return;
    compareModal.classList.remove("visible");
    compareModal.setAttribute("aria-hidden", "true");
  });
  if (compareModal) compareModal.addEventListener("click", (event) => {
    if (event.target === compareModal) {
      compareModal.classList.remove("visible");
      compareModal.setAttribute("aria-hidden", "true");
    }
  });
  if (checkoutBtn) checkoutBtn.addEventListener("click", openCheckoutModal);
  if (checkoutCloseBtn) checkoutCloseBtn.addEventListener("click", closeCheckoutModal);
  if (placeOrderBtn) placeOrderBtn.addEventListener("click", () => {
    if (placeOrderBtn.dataset.state === "done") {
      closeCheckoutModal();
      return;
    }
    startCheckoutProcess();
  });
  if (checkoutModal) checkoutModal.addEventListener("click", (event) => {
    if (event.target === checkoutModal) {
      closeCheckoutModal();
    }
  });
  if (placedOrdersList) placedOrdersList.addEventListener("click", (event) => {
    const item = event.target.closest(".placed-order-item[data-order-id]");
    if (!item) return;
    openOrderDetails(item.getAttribute("data-order-id"));
  });
  if (orderDetailsCloseBtn) orderDetailsCloseBtn.addEventListener("click", closeOrderDetails);
  if (orderCancelBtn) orderCancelBtn.addEventListener("click", cancelCurrentOrder);
  if (orderTrackBtn) orderTrackBtn.addEventListener("click", trackCurrentOrder);
  if (orderReorderBtn) orderReorderBtn.addEventListener("click", reorderCurrentOrder);
  if (orderReturnBtn) orderReturnBtn.addEventListener("click", requestReturnCurrentOrder);
  if (orderDetailsModal) orderDetailsModal.addEventListener("click", (event) => {
    if (event.target === orderDetailsModal) closeOrderDetails();
  });
  if (wishlistList) wishlistList.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-wishlist-action]");
    if (!btn) return;
    const productId = btn.getAttribute("data-product-id");
    if (btn.getAttribute("data-wishlist-action") === "move") addToCart(productId);
    else toggleWishlist(productId);
  });

  // Cart button in the header just scrolls to the cart panel in this demo.
  const cartButton = document.getElementById("cartButton");
  const cartPanel = document.querySelector(".cart-panel");
  if (cartButton && cartPanel) cartButton.addEventListener("click", () => {
    cartPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  });

    applyFilters();
    renderCart();
    renderPlacedOrders();
    renderWishlist();
    renderCompareBar();
  } catch (err) {
    console.error(err);
    showCatalogLoadError(
      `App initialization failed: ${err && err.message ? err.message : "unknown error"}`
    );
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}