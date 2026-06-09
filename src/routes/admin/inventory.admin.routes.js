const express = require("express");
const router  = express.Router();

const Product = require("../../models/Product.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");
const { logAction } = require("../../utils/audit");

router.use(protect, restrictTo("admin"));

// ── GET /api/admin/inventory ──────────────────────────────────
// All products with search + filter
router.get("/", async (req, res) => {
  try {
    const {
      search, category, stockStatus,
      page = 1, limit = 20,
      sortBy = "name", sortDir = "asc",
    } = req.query;

    const query = { isActive: true };

    if (search) {
      query.$or = [
        { name:     { $regex: search, $options: "i" } },
        { sku:      { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
      ];
    }
    if (category) query.category = { $regex: category, $options: "i" };

    // stockStatus filter
    if (stockStatus === "OUT_OF_STOCK") query.stock = 0;
    else if (stockStatus === "LOW_STOCK") query.$expr = { $and: [{ $gt: ["$stock", 0] }, { $lte: ["$stock", "$reorderLevel"] }] };
    else if (stockStatus === "IN_STOCK")  query.$expr = { $gt: ["$stock", "$reorderLevel"] };

    const total    = await Product.countDocuments(query);
    const products = await Product.find(query)
      .select("-movementHistory")   // exclude heavy history from list view
      .sort({ [sortBy]: sortDir === "asc" ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean({ virtuals: true });

    res.json({ success: true, total, page: Number(page), pages: Math.ceil(total / limit), products });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/inventory/low-stock ───────────────────────
router.get("/low-stock", async (req, res) => {
  try {
    const products = await Product.find({
      isActive: true,
      stock: { $gt: 0 },
      $expr: { $lte: ["$stock", "$reorderLevel"] },
    }).select("-movementHistory").lean({ virtuals: true });

    res.json({ success: true, count: products.length, products });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/inventory/out-of-stock ─────────────────────
router.get("/out-of-stock", async (req, res) => {
  try {
    const products = await Product.find({ isActive: true, stock: 0 })
      .select("-movementHistory").lean({ virtuals: true });
    res.json({ success: true, count: products.length, products });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/inventory/dead-stock ──────────────────────
// Products not sold in the last N days (default 30)
router.get("/dead-stock", async (req, res) => {
  try {
    const days    = parseInt(req.query.days) || 30;
    const cutoff  = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const products = await Product.find({
      isActive: true,
      stock: { $gt: 0 },
      $or: [
        { lastSoldAt: { $lt: cutoff } },
        { lastSoldAt: null },           // never sold
      ],
    }).select("-movementHistory").lean({ virtuals: true });

    res.json({ success: true, days, count: products.length, products });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/inventory/:id/movement ────────────────────
router.get("/:id/movement", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .select("name sku movementHistory stock");
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    // Return movement history newest first
    const history = [...product.movementHistory].reverse();
    res.json({ success: true, product: { name: product.name, sku: product.sku, stock: product.stock }, history });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/inventory/:id ─────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean({ virtuals: true });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /api/admin/inventory ─────────────────────────────────
// Create product
router.post("/", async (req, res) => {
  try {
    const { name, sku, category, description, costPrice, sellingPrice, stock, reorderLevel, sellerId } = req.body;

    if (!name) return res.status(400).json({ success: false, message: "Product name is required" });

    const product = await Product.create({
      sellerId: sellerId || req.seller.id,
      name, sku, category, description,
      costPrice:    costPrice    || 0,
      sellingPrice: sellingPrice || 0,
      stock:        stock        || 0,
      reorderLevel: reorderLevel || 5,
    });

    // Log initial stock as a movement
    if (stock > 0) {
      product.movementHistory.push({
        type: "IN", quantity: stock, reason: "Initial stock",
        recordedBy: req.seller.id, stockAfter: stock,
      });
      await product.save();
    }

    await logAction(req, {
      action: "CREATE", entity: "Product",
      entityId: product._id, entityRef: product.name,
      description: `Created product "${product.name}" with stock ${stock || 0}`,
    });

    res.status(201).json({ success: true, product });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/admin/inventory/:id ───────────────────────────
// Edit product details
router.patch("/:id", async (req, res) => {
  try {
    const allowed = ["name", "sku", "category", "description", "costPrice", "sellingPrice", "reorderLevel", "isActive", "imageUrl"];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    const before  = await Product.findById(req.params.id).lean();
    const product = await Product.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    await logAction(req, {
      action: "UPDATE", entity: "Product",
      entityId: product._id, entityRef: product.name,
      description: `Updated product "${product.name}"`,
      before, after: updates,
    });

    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/admin/inventory/:id/stock ─────────────────────
// Adjust stock (add or subtract)
router.patch("/:id/stock", async (req, res) => {
  try {
    const { type, quantity, reason } = req.body;
    // type: "IN" | "OUT" | "ADJUSTMENT" | "RETURN"
    if (!type || !quantity) {
      return res.status(400).json({ success: false, message: "type and quantity are required" });
    }

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    const delta     = ["OUT"].includes(type) ? -Math.abs(quantity) : Math.abs(quantity);
    const newStock  = product.stock + delta;

    if (newStock < 0) {
      return res.status(400).json({ success: false, message: `Cannot reduce stock below 0. Current stock: ${product.stock}` });
    }

    product.stock = newStock;
    product.movementHistory.push({
      type, quantity: delta, reason: reason || type,
      recordedBy: req.seller.id, stockAfter: newStock,
    });

    // Keep only last 200 movements
    if (product.movementHistory.length > 200) {
      product.movementHistory = product.movementHistory.slice(-200);
    }

    await product.save();

    await logAction(req, {
      action: "UPDATE", entity: "Product",
      entityId: product._id, entityRef: product.name,
      description: `Stock ${type}: ${Math.abs(quantity)} units. New stock: ${newStock}`,
      before: { stock: newStock - delta }, after: { stock: newStock },
    });

    res.json({ success: true, stock: product.stock, product });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
