// ═══════════════════════════════════════════════════════════════
// FILE 4: src/routes/admin/reorder.admin.routes.js
// Auto reorder suggestions
// ═══════════════════════════════════════════════════════════════
const express = require("express");
const router  = express.Router();
const Product = require("../../models/Product.model");
const Bill    = require("../../models/Bill.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");

router.use(protect, restrictTo("admin"));

// GET /api/admin/reorder/suggestions
router.get("/suggestions", async (req, res) => {
  try {
    const days30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const days90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    // Get all active products at or below reorder level
    const lowProducts = await Product.find({
      isActive: true,
      $expr: { $lte: ["$stock", "$reorderLevel"] },
    }).lean();

    // Get sales velocity for each product (units sold in last 30 days)
    const salesData = await Bill.aggregate([
      { $match: { createdAt: { $gte: days30 } } },
      { $unwind: "$items" },
      { $group: { _id: "$items.name", soldLast30: { $sum: "$items.quantity" } } },
    ]);

    const salesMap = {};
    salesData.forEach(s => { salesMap[s._id] = s.soldLast30; });

    const suggestions = lowProducts.map(p => {
      const dailyRate    = (salesMap[p.name] || 0) / 30;
      const daysOfStock  = dailyRate > 0 ? Math.floor(p.stock / dailyRate) : null;
      const suggestedQty = Math.max(
        p.reorderLevel * 3,
        Math.ceil(dailyRate * 45) // 45-day supply
      );

      let urgency = "low";
      if (p.stock === 0)          urgency = "critical";
      else if (daysOfStock !== null && daysOfStock <= 7)  urgency = "high";
      else if (daysOfStock !== null && daysOfStock <= 14) urgency = "medium";

      return {
        _id:          p._id,
        name:         p.name,
        sku:          p.sku,
        category:     p.category,
        currentStock: p.stock,
        reorderLevel: p.reorderLevel,
        soldLast30:   salesMap[p.name] || 0,
        dailyRate:    Math.round(dailyRate * 10) / 10,
        daysOfStock,
        suggestedQty,
        urgency,
        costPrice:    p.costPrice,
        estimatedCost: Math.round(suggestedQty * (p.costPrice || 0)),
      };
    });

    // Sort: critical first, then high, medium, low
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    suggestions.sort((a, b) => order[a.urgency] - order[b.urgency]);

    const summary = {
      critical: suggestions.filter(s => s.urgency === "critical").length,
      high:     suggestions.filter(s => s.urgency === "high").length,
      medium:   suggestions.filter(s => s.urgency === "medium").length,
      low:      suggestions.filter(s => s.urgency === "low").length,
      totalEstimatedCost: suggestions.reduce((s, p) => s + p.estimatedCost, 0),
    };

    res.json({ success: true, suggestions, summary, count: suggestions.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/admin/reorder/update-level/:id
// Update reorder level for a product
router.patch("/update-level/:id", async (req, res) => {
  try {
    const { reorderLevel } = req.body;
    if (reorderLevel === undefined || reorderLevel < 0)
      return res.status(400).json({ success: false, message: "Valid reorderLevel required" });
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { reorderLevel },
      { new: true }
    ).select("name sku stock reorderLevel");
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
