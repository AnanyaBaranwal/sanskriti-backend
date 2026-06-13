// ═══════════════════════════════════════════════════════════════
// FILE 1: src/routes/admin/duplicate.admin.routes.js
// Duplicate order detection
// ═══════════════════════════════════════════════════════════════
const express = require("express");
const router  = express.Router();
const Order   = require("../../models/Order.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");

router.use(protect, restrictTo("admin"));

// GET /api/admin/duplicates
// Finds orders with same buyer phone + same items within 24 hours
router.get("/", async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const orders = await Order.find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .lean();

    const groups = {};
    for (const order of orders) {
      const phone = order.buyer?.phone;
      if (!phone) continue;
      const itemKey = (order.items || [])
        .map(i => `${i.name}:${i.quantity}`)
        .sort()
        .join("|");
      const key = `${phone}::${itemKey}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(order);
    }

    const duplicates = Object.values(groups)
      .filter(g => g.length > 1)
      .map(g => ({
        buyerPhone: g[0].buyer?.phone,
        buyerName:  g[0].buyer?.name,
        itemsSummary: (g[0].items || []).map(i => `${i.name} x${i.quantity}`).join(", "),
        orders: g.map(o => ({
          _id:         o._id,
          orderNumber: o.orderNumber,
          total:       o.total,
          status:      o.status,
          createdAt:   o.createdAt,
        })),
        count: g.length,
      }));

    res.json({ success: true, duplicates, count: duplicates.length, checkedOrders: orders.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
