const express = require("express");
const router  = express.Router();

const Order   = require("../../models/Order.model");
const Bill    = require("../../models/Bill.model");
const Seller  = require("../../models/Seller.model");
const Product = require("../../models/Product.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");

router.use(protect, restrictTo("admin"));

// ── GET /api/admin/search?q=searchterm ───────────────────────
// Searches across Orders, Bills, Clients, Products
// Returns results grouped by entity type
router.get("/", async (req, res) => {
  try {
    const { q, limit = 5 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "Search query must be at least 2 characters",
      });
    }

    const term  = q.trim();
    const n     = Number(limit);
    const regex = { $regex: term, $options: "i" };

    // Run all searches in parallel
    const [orders, bills, clients, products] = await Promise.all([

      // Orders — search by orderNumber, buyer name, buyer phone
      Order.find({
        $or: [
          { orderNumber:   regex },
          { "buyer.name":  regex },
          { "buyer.phone": regex },
          { "buyer.email": regex },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(n)
        .select("orderNumber buyer.name buyer.phone status total createdAt")
        .lean(),

      // Bills — search by invoiceNumber, buyer name, buyer phone
      Bill.find({
        $or: [
          { invoiceNumber: regex },
          { "buyer.name":  regex },
          { "buyer.phone": regex },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(n)
        .select("invoiceNumber buyer.name buyer.phone grandTotal paymentStatus createdAt")
        .lean(),

      // Clients — search by name, phone, email
      Seller.find({
        $or: [
          { name:  regex },
          { phone: regex },
          { email: regex },
        ],
      })
        .sort({ totalRevenue: -1 })
        .limit(n)
        .select("name phone email totalOrders totalRevenue address.city address.state")
        .lean(),

      // Products — search by name, SKU, category
      Product.find({
        isActive: true,
        $or: [
          { name:     regex },
          { sku:      regex },
          { category: regex },
        ],
      })
        .limit(n)
        .select("name sku category stock stockStatus sellingPrice")
        .lean({ virtuals: true }),
    ]);

    const totalResults = orders.length + bills.length + clients.length + products.length;

    res.json({
      success: true,
      query: term,
      totalResults,
      results: {
        orders:   { count: orders.length,   data: orders },
        bills:    { count: bills.length,    data: bills },
        clients:  { count: clients.length,  data: clients },
        products: { count: products.length, data: products },
      },
    });
  } catch (err) {
    console.error("[search]", err);
    res.status(500).json({ success: false, message: "Search failed" });
  }
});

// ── GET /api/admin/search/orders?q= ──────────────────────────
// Dedicated order search with more fields
router.get("/orders", async (req, res) => {
  try {
    const { q, page = 1, limit = 20 } = req.query;
    if (!q?.trim()) return res.status(400).json({ success: false, message: "Query required" });

    const regex = { $regex: q.trim(), $options: "i" };
    const filter = {
      $or: [
        { orderNumber:   regex },
        { "buyer.name":  regex },
        { "buyer.phone": regex },
        { "buyer.email": regex },
      ],
    };

    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip((page-1)*limit).limit(Number(limit)).lean(),
      Order.countDocuments(filter),
    ]);

    res.json({ success: true, total, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/search/clients?q= ─────────────────────────
router.get("/clients", async (req, res) => {
  try {
    const { q, page = 1, limit = 20 } = req.query;
    if (!q?.trim()) return res.status(400).json({ success: false, message: "Query required" });

    const regex  = { $regex: q.trim(), $options: "i" };
    const filter = { $or: [{ name: regex }, { phone: regex }, { email: regex }] };

    const [clients, total] = await Promise.all([
      Seller.find(filter).sort({ totalRevenue: -1 }).skip((page-1)*limit).limit(Number(limit)).lean({ virtuals: true }),
      Seller.countDocuments(filter),
    ]);

    res.json({ success: true, total, clients });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
