const GalleryProduct = require("../models/GalleryProduct.model");
const { logAction } = require("../utils/audit");

// ═════════════════════════════════════════════════════════════════════════
// PUBLIC / SELLER — browsing the gallery
// ═════════════════════════════════════════════════════════════════════════

// ── GET /api/gallery/products ─────────────────────────────────────────────
// Public route (optionalAuth). Anyone can see the catalog; only a logged-in
// seller sees costPrice. This mirrors "All products visible to everyone.
// Sign in to unlock prices."
exports.getGalleryProducts = async (req, res) => {
  try {
    const {
      search, category, inStock, featured,
      page = 1, limit = 24,
      sortBy = "createdAt", sortDir = "desc",
    } = req.query;

    const query = { isActive: true };
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { sku: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
        { origin: { $regex: search, $options: "i" } },
      ];
    }
    if (category && category !== "All") query.category = category;
    if (inStock === "true") query.inStock = true;
    if (featured === "true") query.featured = true;

    const total = await GalleryProduct.countDocuments(query);
    let products = await GalleryProduct.find(query)
      .sort({ [sortBy]: sortDir === "asc" ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean({ virtuals: true });

    const isLoggedIn = !!req.seller;
    if (!isLoggedIn) {
      // Strip pricing for guests — they must sign in to see cost price.
      products = products.map(({ costPrice, mrp, ...rest }) => rest);
    }

    res.json({
      success: true,
      isLoggedIn,
      products,
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("[gallery/products]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── GET /api/gallery/products/:id ─────────────────────────────────────────
exports.getGalleryProductById = async (req, res) => {
  try {
    let product = await GalleryProduct.findOne({ _id: req.params.id, isActive: true }).lean({ virtuals: true });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    if (!req.seller) {
      const { costPrice, mrp, ...rest } = product;
      product = rest;
    }

    res.json({ success: true, isLoggedIn: !!req.seller, product });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── GET /api/gallery/categories ───────────────────────────────────────────
exports.getGalleryCategories = async (req, res) => {
  try {
    const categories = await GalleryProduct.distinct("category", { isActive: true });
    res.json({ success: true, categories });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ═════════════════════════════════════════════════════════════════════════
// ADMIN — catalog management
// ═════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/gallery ────────────────────────────────────────────────
exports.adminListGalleryProducts = async (req, res) => {
  try {
    const { search, category, page = 1, limit = 50 } = req.query;
    const query = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { sku: { $regex: search, $options: "i" } },
      ];
    }
    if (category && category !== "All") query.category = category;

    const total = await GalleryProduct.countDocuments(query);
    const products = await GalleryProduct.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean({ virtuals: true });

    res.json({ success: true, products, pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── GET /api/admin/gallery/categories ─────────────────────────────────────
// Purely derived from whatever the admin has typed so far — no fixed list.
exports.adminGetGalleryCategories = async (req, res) => {
  try {
    const categories = await GalleryProduct.distinct("category");
    res.json({ success: true, categories: categories.filter(Boolean).sort() });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── GET /api/admin/gallery/:id ────────────────────────────────────────────
exports.adminGetGalleryProduct = async (req, res) => {
  try {
    const product = await GalleryProduct.findById(req.params.id).lean({ virtuals: true });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── POST /api/admin/gallery ───────────────────────────────────────────────
exports.adminCreateGalleryProduct = async (req, res) => {
  try {
    const {
      name, sku, category, origin, condition, description,
      images, imageUrl, costPrice, mrp, stockQty, featured, certificate,
      tag,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Product name is required" });
    }
    if (costPrice === undefined || costPrice === null || Number(costPrice) < 0) {
      return res.status(400).json({ success: false, message: "A valid cost price is required" });
    }

    const product = await GalleryProduct.create({
      name, sku, category, origin, condition, description,
      images: images || [], imageUrl: imageUrl || "",
      costPrice: Number(costPrice),
      mrp: Number(mrp) || 0,
      stockQty: Number(stockQty) || 0,
      inStock: Number(stockQty) > 0,
      tag: tag || "",
      featured: !!featured,
      certificate: !!certificate,
    });

    await logAction(req, {
      action: "CREATE", entity: "GalleryProduct",
      entityId: product._id, entityRef: product.name,
      description: `Added "${product.name}" to the Gallery catalog (cost ₹${product.costPrice})`,
    });

    res.status(201).json({ success: true, product });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── PATCH /api/admin/gallery/:id ──────────────────────────────────────────
exports.adminUpdateGalleryProduct = async (req, res) => {
  try {
    const allowed = [
      "name", "sku", "category", "origin", "condition", "description",
      "images", "imageUrl", "costPrice", "mrp", "stockQty", "inStock",
      "featured", "certificate", "isActive", "tag",
    ];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    const before = await GalleryProduct.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ success: false, message: "Product not found" });

    const product = await GalleryProduct.findByIdAndUpdate(req.params.id, updates, { new: true });

    await logAction(req, {
      action: "UPDATE", entity: "GalleryProduct",
      entityId: product._id, entityRef: product.name,
      description: `Updated Gallery product "${product.name}"`,
      before, after: updates,
    });

    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── PATCH /api/admin/gallery/:id/stock ────────────────────────────────────
exports.adminUpdateStock = async (req, res) => {
  try {
    const { stockQty, inStock } = req.body;
    const product = await GalleryProduct.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    if (stockQty !== undefined) product.stockQty = Math.max(0, Number(stockQty));
    product.inStock = inStock !== undefined ? !!inStock : product.stockQty > 0;
    await product.save();

    await logAction(req, {
      action: "UPDATE", entity: "GalleryProduct",
      entityId: product._id, entityRef: product.name,
      description: `Stock updated for "${product.name}" (qty: ${product.stockQty}, inStock: ${product.inStock})`,
    });

    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── DELETE /api/admin/gallery/:id ─────────────────────────────────────────
// Soft delete — keeps history/references from GalleryOrders intact.
exports.adminDeleteGalleryProduct = async (req, res) => {
  try {
    const product = await GalleryProduct.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    await logAction(req, {
      action: "DELETE", entity: "GalleryProduct",
      entityId: product._id, entityRef: product.name,
      description: `Removed "${product.name}" from the Gallery catalog`,
    });

    res.json({ success: true, message: "Product removed from gallery" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};
