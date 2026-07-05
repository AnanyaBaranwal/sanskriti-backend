const express  = require("express");
const router   = express.Router();

const Seller = require("../../models/kyc.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");
const { logAction } = require("../../utils/audit");

router.use(protect, restrictTo("admin"));

const VALID_KYC_STATUSES = ["not_submitted", "under_review", "approved", "rejected"];

// GET /api/admin/sellers
router.get("/", async (req, res) => {
  try {
    const {
      search, kycStatus,
      page = 1, limit = 20,
      includeAdmins = "false",
    } = req.query;

    const baseFilter = {};
    if (includeAdmins !== "true") baseFilter.role = { $ne: "admin" };

    const filter = { ...baseFilter };
    if (kycStatus && VALID_KYC_STATUSES.includes(kycStatus)) {
      filter.kycStatus = kycStatus;
    }
    if (search) {
      filter.$or = [
        { name:  { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    const [sellers, total, counts] = await Promise.all([
      Seller.find(filter)
        .sort({ "kyc.submittedAt": -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      Seller.countDocuments(filter),
      Seller.aggregate([
        { $match: baseFilter },
        { $group: { _id: "$kycStatus", count: { $sum: 1 } } },
      ]),
    ]);

    const kycCounts = {
      all: await Seller.countDocuments(baseFilter),
      not_submitted: 0,
      under_review: 0,
      approved: 0,
      rejected: 0,
    };
    counts.forEach(c => { if (kycCounts[c._id] !== undefined) kycCounts[c._id] = c.count; });

    res.json({
      success: true,
      total,
      page: Number(page),
      pages: Math.ceil(total / limit),
      sellers,
      kycCounts,
    });
  } catch (err) {
    console.error("[admin/sellers list]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /api/admin/sellers/:id
router.get("/:id", async (req, res) => {
  try {
    const seller = await Seller.findById(req.params.id).lean();
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });
    res.json({ success: true, seller });
  } catch (err) {
    console.error("[admin/sellers detail]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// PATCH /api/admin/sellers/:id/kyc
router.patch("/:id/kyc", async (req, res) => {
  try {
    const { status, note } = req.body;

    if (!VALID_KYC_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Valid: ${VALID_KYC_STATUSES.join(", ")}`,
      });
    }

    const seller = await Seller.findById(req.params.id);
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });

    const before = seller.kycStatus;

    seller.kycStatus        = status;
    seller.kyc.adminNote    = note || "";
    seller.kyc.reviewedAt   = new Date();
    seller.kyc.reviewedBy   = req.seller?.name || "Admin";

    if (status === "approved" && seller.status === "pending") {
      seller.status = "active";
    }

    await seller.save();

    await logAction(req, {
      action:      "STATUS_CHANGE",
      entity:      "Seller",
      entityId:    seller._id,
      entityRef:   seller.name,
      description: `KYC for ${seller.name} (${seller.email}): ${before} → ${status}${note ? ` — "${note}"` : ""}`,
      before:      { kycStatus: before },
      after:       { kycStatus: status },
    });

    res.json({ success: true, message: `KYC ${status.replace("_", " ")}`, seller });
  } catch (err) {
    console.error("[admin/sellers kyc update]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// PATCH /api/admin/sellers/:id/status
// Activate / suspend a seller account (admin accounts are protected)
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["active", "suspended"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const seller = await Seller.findById(req.params.id);
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });
    if (seller.role === "admin") {
      return res.status(403).json({ success: false, message: "Admin accounts cannot be suspended" });
    }

    const before = seller.status;
    seller.status = status;
    await seller.save();

    await logAction(req, {
      action:      "STATUS_CHANGE",
      entity:      "Seller",
      entityId:    seller._id,
      entityRef:   seller.name,
      description: `Account for ${seller.name} (${seller.email}): ${before} → ${status}`,
      before:      { status: before },
      after:       { status },
    });

    res.json({ success: true, message: `Account ${status}`, seller });
  } catch (err) {
    console.error("[admin/sellers status update]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
