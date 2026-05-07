"use strict";

window.DL_RECOMMENDER = {
  ready: false,         
  scores: null,         
  model: null,          
  modelInfo: {
    epochs: 0,
    loss: null,
    trainedAt: null,
    interactionCount: 0,
  },
};

let _model = null;
let _productIndexMap = null;  
let _pendingInteractions = 0;
const RETRAIN_AFTER = 3;      
const MIN_INTERACTIONS = 1;   
const EPOCHS = 40;

const INTERACTION_WEIGHTS = {
  cart:            3.0,  
  wishlist_save:   2.5,  
  compare:         2.0,  
  search_click:    1.25, 
  view:            1.0,  
  wishlist_remove: -1.0, 
  not_interested:  -3.0, 
};

function _setBadge(state, text) {
  const el = document.getElementById("dlModelStatus");
  if (!el) return;
  el.className = `dl-model-badge dl-${state}`;
  el.textContent = text;
}

function _ensureIndexMap() {
  if (_productIndexMap) return;
  _productIndexMap = new Map();
  (window.SHOP_EASE_PRODUCTS_RUNTIME || []).forEach((p, i) => {
    _productIndexMap.set(p.id, i);
  });
}

function _buildInteractionVector(events, nProducts) {
 
  const vec = new Float32Array(nProducts);
  const now = Date.now();

  events.forEach((ev) => {
    const idx = _productIndexMap ? _productIndexMap.get(ev.productId) : -1;
    if (idx == null || idx < 0) return;
    const ageDays = Math.max(0, (now - Number(ev.ts || now)) / 86400000);
    const recency = Math.exp(-ageDays / 14);
    const baseWeight = INTERACTION_WEIGHTS[ev.type] ?? 1.0;
    const w = baseWeight * recency;
    vec[idx] = Math.max(-1, Math.min(1, vec[idx] + w / 6));
  });

  return vec;
}

function _buildModel(nProducts) {
  const model = tf.sequential({ name: "shopease_reco_ae" });

 
  model.add(tf.layers.dense({
    inputShape: [nProducts], units: 128, activation: "relu",
    kernelInitializer: "glorotUniform", name: "enc1"
  }));
  model.add(tf.layers.dense({ units: 64, activation: "relu", name: "enc2" }));
  model.add(tf.layers.dense({ units: 32, activation: "relu", name: "bottleneck" }));

 
  model.add(tf.layers.dense({ units: 64, activation: "relu", name: "dec1" }));
  model.add(tf.layers.dense({ units: 128, activation: "relu", name: "dec2" }));
  model.add(tf.layers.dense({
    units: nProducts, activation: "tanh", name: "output"
  }));

  model.compile({
    optimizer: tf.train.adam(0.005),
    loss: "meanSquaredError",
  });

  return model;
}

async function _train(events, products) {
  if (!window.tf) {
    console.warn("[DL] TensorFlow.js not loaded – skipping DL training.");
    _setBadge("fallback", "heuristic mode");
    return;
  }

  const n = products.length;
  if (!n) return;

  _ensureIndexMap();

  const vec = _buildInteractionVector(events, n);
  const nonZero = vec.filter((v) => v !== 0).length;

  if (nonZero < MIN_INTERACTIONS) {
    _setBadge("fallback", "heuristic mode");
    return;
  }

  _setBadge("training", `training…`);

 
  if (_model) {
    _model.dispose();
    _model = null;
  }

  _model = _buildModel(n);
  window.DL_RECOMMENDER.model = _model;

 
  const augmentedRows = _augment(vec, 16);
  const xs = tf.tensor2d(augmentedRows, [augmentedRows.length, n]);

  let finalLoss = null;
  try {
    const history = await _model.fit(xs, xs, {
      epochs: EPOCHS,
      batchSize: Math.min(8, augmentedRows.length),
      shuffle: true,
      verbose: 0,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          if (epoch % 10 === 0) {
            _setBadge("training", `training… epoch ${epoch + 1}/${EPOCHS}`);
          }
          finalLoss = logs.loss;
        },
      },
    });
    void history;
  } finally {
    xs.dispose();
  }

 
  const inputT = tf.tensor2d([Array.from(vec)], [1, n]);
  const outputT = _model.predict(inputT);
  const scores = await outputT.data();
  inputT.dispose();
  outputT.dispose();

 
 
  const result = new Float32Array(scores);
  vec.forEach((v, i) => {
    if (v > 0) result[i] *= 0.3;      
    if (v < 0) result[i] = Math.min(result[i], -0.5);
  });

  window.DL_RECOMMENDER.scores = result;
  window.DL_RECOMMENDER.ready = true;
  window.DL_RECOMMENDER.modelInfo = {
    epochs: EPOCHS,
    loss: finalLoss ? +finalLoss.toFixed(6) : null,
    trainedAt: Date.now(),
    interactionCount: nonZero,
  };

  _pendingInteractions = 0;
  _setBadge("ready", `neural model active`);

 
  if (typeof window.renderRecommendations === "function") {
    window.renderRecommendations();
  }
}

function _augment(vec, copies) {
  const rows = [Array.from(vec)];
  for (let c = 0; c < copies - 1; c++) {
    const copy = new Float32Array(vec);
    for (let i = 0; i < copy.length; i++) {
      if (copy[i] > 0 && Math.random() < 0.2) copy[i] = 0;
    }
    rows.push(Array.from(copy));
  }
  return rows;
}

/**
 * Initialize the DL recommender.
 * Call this from init() after products and history are loaded.
 *
 * @param {Array} events   - recommenderHistory.events
 * @param {Array} products - PRODUCTS array
 */
window.DL_RECOMMENDER.init = async function (events, products) {
 
  window.SHOP_EASE_PRODUCTS_RUNTIME = products;
  _productIndexMap = null;
  await _train(events, products);
};

/**
 * Call whenever a new interaction is recorded.
 * Will retrain after RETRAIN_AFTER accumulated new interactions.
 *
 * @param {Array} events   - recommenderHistory.events (full, updated list)
 * @param {Array} products - PRODUCTS array
 */
window.DL_RECOMMENDER.onNewInteraction = async function (events, products) {
  _pendingInteractions++;
  if (_pendingInteractions >= RETRAIN_AFTER) {
    window.SHOP_EASE_PRODUCTS_RUNTIME = products;
    await _train(events, products);
  }
};

/**
 * Score a single product for the current user.
 * Returns a number in [0, 1] — higher = more recommended.
 * Falls back to 0 if DL scores aren't ready.
 *
 * @param {*} productId
 * @returns {number}
 */
window.DL_RECOMMENDER.getScore = function (productId) {
  if (!window.DL_RECOMMENDER.scores || !_productIndexMap) return 0;
  const idx = _productIndexMap.get(productId);
  return idx != null ? window.DL_RECOMMENDER.scores[idx] : 0;
};