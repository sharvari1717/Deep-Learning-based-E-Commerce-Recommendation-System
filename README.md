# E-Commerce Recommendation System with Deep Learning

A browser-based e-commerce platform with a real-time deep learning recommendation 
engine that trains entirely in the browser using TensorFlow.js — no backend required.

## Project Details

- **Autoencoder recommender** — 6-layer neural network that learns user preferences 
  from interaction history and scores all products
- **Multi-signal learning** — learns from views, cart additions, wishlist saves, 
  comparisons, and explicit not-interested signals (positive and negative weights)
- **Taste profile visualisation** — live bar chart of learned category and brand 
  affinities updated after every interaction
- **Hybrid ranking** — DL scores blended with heuristic signals (rating, recency, 
  session behaviour)
- **Full shopping flow** — cart, wishlist, filters, search, order placement

## Model

6-layer autoencoder: `Input → 128 → 64 → 32 (bottleneck) → 64 → 128 → Output`  
Trained with Adam, MSE loss, 40 epochs, retrains every 3 interactions.

## Run

```bash
python3 -m http.server 8080   # then open http://localhost:8080
# or
npx serve .
```

## Inspect the model in console

```javascript
window.DL_RECOMMENDER.model.summary()   // layer architecture
window.DL_RECOMMENDER.modelInfo         // loss, epochs, interaction count
```

## Stack
TensorFlow.js · Vanilla JS · HTML/CSS · localStorage
