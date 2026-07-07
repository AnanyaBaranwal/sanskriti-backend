const express = require("express");
const router = express.Router();

const {
  adminListGalleryProducts,
  adminGetGalleryProduct,
  adminGetGalleryCategories,
  adminCreateGalleryProduct,
  adminUpdateGalleryProduct,
  adminUpdateStock,
  adminDeleteGalleryProduct,
} = require("../../controllers/galleryProductController");

const { protect, restrictTo } = require("../../middleware/auth.middleware");

router.use(protect, restrictTo("admin"));

// ── GET /api/admin/gallery ─────────────────────────────────────
router.get("/", adminListGalleryProducts);

// ── GET /api/admin/gallery/categories ──────────────────────────
// Must come before /:id so "categories" isn't treated as an id.
router.get("/categories", adminGetGalleryCategories);

// ── GET /api/admin/gallery/:id ─────────────────────────────────
router.get("/:id", adminGetGalleryProduct);

// ── POST /api/admin/gallery ────────────────────────────────────
router.post("/", adminCreateGalleryProduct);

// ── PATCH /api/admin/gallery/:id ───────────────────────────────
router.patch("/:id", adminUpdateGalleryProduct);

// ── PATCH /api/admin/gallery/:id/stock ─────────────────────────
router.patch("/:id/stock", adminUpdateStock);

// ── DELETE /api/admin/gallery/:id ──────────────────────────────
router.delete("/:id", adminDeleteGalleryProduct);

module.exports = router;
