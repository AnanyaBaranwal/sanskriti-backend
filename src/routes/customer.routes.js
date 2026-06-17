const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");
const Client   = require("../models/Client.model");
const Order    = require("../models/Order.model");
const { protect } = require("../middleware/auth.middleware");

router.use(protect);

// ── GET /api/customers/stats — summary cards ──────────────────
// NOTE: declared before "/:id" so "stats" isn't swallowed as an id.
router.get("/stats", async (req, res) => {
  try {
    const sellerId = new mongoose.Types.ObjectId(req.seller.id);
    const [totalCustomers, agg, repeatCustomers] = await Promise.all([
      Client.countDocuments({ sellerId }),
      Client.aggregate([
        { $match: { sellerId } },
        { $group: { _id: null, revenue: { $sum: "$totalRevenue" }, pending: { $sum: "$pendingPayments" } } },
      ]),
      Client.countDocuments({ sellerId, totalOrders: { $gt: 1 } }),
    ]);

    res.json({
      success: true,
      stats: {
        totalCustomers,
        totalRevenue:    agg[0]?.revenue || 0,
        pendingPayments: agg[0]?.pending || 0,
        repeatCustomers,
      },
    });
  } catch (err) {
    console.error("[customers/stats]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/customers?search=&sort=&page=&limit= ─────────────
router.get("/", async (req, res) => {
  try {
    const { search = "", sort = "-lastOrderAt", page = 1, limit = 20 } = req.query;
    const filter = { sellerId: req.seller.id };
    if (search) {
      filter.$or = [
        { name:  { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const [customers, total] = await Promise.all([
      Client.find(filter).sort(sort).skip((page - 1) * limit).limit(Number(limit)),
      Client.countDocuments(filter),
    ]);

    res.json({ success: true, customers, total, page: Number(page), pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    console.error("[customers/list]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/customers/:id ─────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const customer = await Client.findOne({ _id: req.params.id, sellerId: req.seller.id });
    if (!customer) return res.status(404).json({ success: false, message: "Customer not found" });
    res.json({ success: true, customer });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/customers/:id/orders — full order history ────────
router.get("/:id/orders", async (req, res) => {
  try {
    const customer = await Client.findOne({ _id: req.params.id, sellerId: req.seller.id });
    if (!customer) return res.status(404).json({ success: false, message: "Customer not found" });
    const orders = await Order.find({ clientId: customer._id }).sort({ createdAt: -1 });
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /api/customers/:id/notes — add an internal note ──────
router.post("/:id/notes", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ success: false, message: "Note text is required" });

    const customer = await Client.findOneAndUpdate(
      { _id: req.params.id, sellerId: req.seller.id },
      { $push: { notes: { text: text.trim(), addedBy: req.seller.id, addedByName: req.seller.name || null } } },
      { new: true }
    );
    if (!customer) return res.status(404).json({ success: false, message: "Customer not found" });
    res.json({ success: true, notes: customer.notes });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
