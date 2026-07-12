const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");
const Order    = require("../models/Order.model");
const Seller   = require("../models/Seller.model");
const { protect } = require("../middleware/auth.middleware");

router.use(protect);

// ── GET /api/analytics/overview?months=6 ──────────────────────
router.get("/overview", async (req, res) => {
  try {
    const sellerId = new mongoose.Types.ObjectId(req.seller.id);
    const months   = Math.min(parseInt(req.query.months) || 6, 12);

    const since = new Date();
    since.setMonth(since.getMonth() - (months - 1));
    since.setDate(1);
    since.setHours(0, 0, 0, 0);

    const [trendRaw, statusBreakdown, topProducts, topCustomers] = await Promise.all([
      // Revenue + order count per month
      Order.aggregate([
        { $match: { sellerId, createdAt: { $gte: since }, status: { $ne: "CANCELLED" } } },
        { $group: {
            _id:     { y: { $year: "$createdAt" }, m: { $month: "$createdAt" } },
            revenue: { $sum: "$total" },
            orders:  { $sum: 1 },
        } },
        { $sort: { "_id.y": 1, "_id.m": 1 } },
      ]),

      // Order status breakdown (all time)
      Order.aggregate([
        { $match: { sellerId } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),

      // Top 5 products by revenue (all time, excludes cancelled)
      Order.aggregate([
        { $match: { sellerId, status: { $ne: "CANCELLED" } } },
        { $unwind: "$items" },
        { $group: {
            _id:     "$items.name",
            revenue: { $sum: "$items.total" },
            qty:     { $sum: "$items.quantity" },
        } },
        { $sort: { revenue: -1 } },
        { $limit: 5 },
      ]),

      // Top 5 customers by revenue — reuses cached Seller stats
      Seller.find({ sellerId }).sort({ totalRevenue: -1 }).limit(5).select("name phone totalOrders totalRevenue"),
    ]);

    // Fill in months with no orders so the chart has no gaps
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const trend = [];
    const cursor = new Date(since);
    for (let i = 0; i < months; i++) {
      const y = cursor.getFullYear();
      const m = cursor.getMonth() + 1;
      const found = trendRaw.find(t => t._id.y === y && t._id.m === m);
      trend.push({
        month:   monthNames[m - 1],
        year:    y,
        revenue: found?.revenue || 0,
        orders:  found?.orders  || 0,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    const totalRevenue = trend.reduce((s, t) => s + t.revenue, 0);
    const totalOrders  = trend.reduce((s, t) => s + t.orders, 0);

    res.json({
      success: true,
      trend,
      totals: { revenue: totalRevenue, orders: totalOrders },
      statusBreakdown,
      topProducts,
      topCustomers,
    });
  } catch (err) {
    console.error("[analytics/overview]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
