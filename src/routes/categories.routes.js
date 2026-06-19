const express  = require("express");
const router   = express.Router();
const Category = require("../models/Category.model");

// ── GET /api/categories ────────────────────────────────────────
// Public, no auth required — used by the seller-facing gallery page
// for both the "Choose the Category" grid and the hero carousel.
router.get("/", async (req, res) => {
  try {
    const categories = await Category.find({ isActive: true })
      .sort({ displayOrder: 1 })
      .select("label slug image heroImage count showInHero heroOrder")
      .lean();

    res.json({ success: true, categories });
  } catch (err) {
    console.error("[categories]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
