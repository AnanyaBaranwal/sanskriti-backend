const express = require("express");
const router = express.Router();

const Seller = require("../../models/Seller.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");
const { logAction } = require("../../utils/audit");
const { escapeRegex } = require("../../utils/escapeRegex");

// All seller admin routes require login + admin role
router.use(protect, restrictTo("admin"));

// ── GET /api/admin/sellers ─────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const {
      search, state, city, status,
      page = 1, limit = 20,
      sortBy = "createdAt", sortDir = "desc",
    } = req.query;

    const query = {};

    if (search) {
      const safe = escapeRegex(search);
      query.$or = [
        { name: { $regex: safe, $options: "i" } },
        { phone: { $regex: safe, $options: "i" } },
        { email: { $regex: safe, $options: "i" } },
        { company: { $regex: safe, $options: "i" } },
        { gstNumber: { $regex: safe, $options: "i" } },
      ];
    }
    if (state) query["address.state"] = { $regex: escapeRegex(state), $options: "i" };
    if (city) query["address.city"] = { $regex: escapeRegex(city), $options: "i" };
    if (status) query.status = status;

    const total = await Seller.countDocuments(query);
    const active = await Seller.countDocuments({ ...query, status: "active" });

    const sellers = await Seller.find(query)
      .sort({ [sortBy]: sortDir === "asc" ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    res.json({
      success: true,
      total,
      page: Number(page),
      pages: Math.ceil(total / limit),
      stats: { total, active },
      sellers,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/sellers/:id ─────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const seller = await Seller.findById(req.params.id).lean();
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });

    res.json({ success: true, seller });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/admin/sellers/:id ───────────────────────────────
// Admin-editable fields only — never role, passwordHash, refreshToken here.
router.patch("/:id", async (req, res) => {
  try {
    const allowed = ["name", "phone", "address", "company", "gstNumber", "status"];
    const updates = {};
    allowed.forEach((f) => {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: "No valid fields provided to update" });
    }

    const before = await Seller.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ success: false, message: "Seller not found" });

    const seller = await Seller.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    await logAction(req, {
      action: "UPDATE",
      entity: "Seller",
      entityId: seller._id,
      entityRef: seller.name,
      description: `Updated seller info for ${seller.name}`,
      before,
      after: updates,
    });

    res.json({ success: true, seller });
  } catch (err) {
    console.error(err);
    if (err.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: Object.values(err.errors).map((e) => e.message).join(", "),
      });
    }
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/admin/sellers/:id/status ────────────────────────
// Separate endpoint for the sensitive status transition (activate/suspend),
// so it's auditable distinctly from a general profile edit.
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["pending", "active", "suspended"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status value" });
    }

    const before = await Seller.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ success: false, message: "Seller not found" });

    const seller = await Seller.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true, runValidators: true }
    );

    await logAction(req, {
      action: "UPDATE",
      entity: "Seller",
      entityId: seller._id,
      entityRef: seller.name,
      description: `Changed seller status for ${seller.name}: ${before.status} → ${status}`,
      before: { status: before.status },
      after: { status },
    });

    res.json({ success: true, seller });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── DELETE /api/admin/sellers/:id ──────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const seller = await Seller.findByIdAndDelete(req.params.id);
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });

    await logAction(req, {
      action: "DELETE",
      entity: "Seller",
      entityId: req.params.id,
      entityRef: seller.name,
      description: `Deleted seller ${seller.name}`,
    });

    res.json({ success: true, message: "Seller deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
