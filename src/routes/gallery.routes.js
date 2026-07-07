const express = require("express");
const router = express.Router();

const {
  getGalleryProducts,
  getGalleryProductById,
  getGalleryCategories,
} = require("../controllers/galleryProductController");

const { optionalAuth } = require("../middleware/optionalAuth.middleware");

// ── Public browsing (price hidden unless logged in) ───────────────────────
// Placing an order now happens via the existing POST /api/orders — every
// order is sourced from this catalog, so there's no separate "gallery order"
// endpoint anymore.
router.get("/products", optionalAuth, getGalleryProducts);
router.get("/products/:id", optionalAuth, getGalleryProductById);
router.get("/categories", getGalleryCategories);

module.exports = router;
