const express  = require("express");
const router   = express.Router();

const Seller = require("../../models/Seller.model"); // renamed from kyc.model.js
const Kyc    = require("../../models/Kyc.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");
const { logAction } = require("../../utils/audit");

router.use(protect, restrictTo("admin"));

const VALID_KYC_STATUSES = ["not_submitted", "under_review", "approved", "rejected"];

// GET /api/admin/sellers  (URL kept as-is — frontend already calls this)
router.get("/", async (req, res) => {
  try {
    const {
      search, kycStatus,
      page = 1, limit = 20,
      includeAdmins = "false",
    } = req.query;

    const baseFilter = {};
    if (includeAdmins !== "true") baseFilter.role = { $ne: "admin" };

    // If filtering by kycStatus, find matching sellerIds from Kyc collection first
    let sellerIdFilter = null;
    if (kycStatus && VALID_KYC_STATUSES.includes(kycStatus)) {
      if (kycStatus === "not_submitted") {
        // Sellers with NO Kyc doc at all, or an explicit not_submitted one
        const submitted = await Kyc.find({ status: { $ne: "not_submitted" } }).distinct("sellerId");
        sellerIdFilter = { $nin: submitted };
      } else {
        sellerIdFilter = { $in: await Kyc.find({ status: kycStatus }).distinct("sellerId") };
      }
    }

    const filter = { ...baseFilter };
    if (sellerIdFilter) filter._id = sellerIdFilter;
    if (search) {
      filter.$or = [
        { name:  { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    const [sellersRaw, total] = await Promise.all([
      Seller.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      Seller.countDocuments(filter),
    ]);

    // Attach each seller's Kyc record (if any)
    const sellerIds = sellersRaw.map(s => s._id);
    const kycDocs = await Kyc.find({ sellerId: { $in: sellerIds } }).lean();
    const kycBySellerId = {};
    kycDocs.forEach(k => { kycBySellerId[k.sellerId.toString()] = k; });

    const sellers = sellersRaw.map(s => ({
      ...s,
      kycStatus: kycBySellerId[s._id.toString()]?.status || "not_submitted",
      kyc: kycBySellerId[s._id.toString()] || null,
    }));

    // Counts for the stat cards — computed across ALL sellers (not just this page)
    const allSellerIds = await Seller.find(baseFilter).distinct("_id");
    const allKyc = await Kyc.find({ sellerId: { $in: allSellerIds } }).select("sellerId status").lean();
    const kycCounts = { all: allSellerIds.length, not_submitted: 0, under_review: 0, approved: 0, rejected: 0 };
    const withKyc = new Set();
    allKyc.forEach(k => {
      withKyc.add(k.sellerId.toString());
      if (kycCounts[k.status] !== undefined) kycCounts[k.status]++;
    });
    kycCounts.not_submitted = allSellerIds.length - withKyc.size;

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

    const kyc = await Kyc.findOne({ sellerId: req.params.id }).lean();

    res.json({
      success: true,
      seller: { ...seller, kycStatus: kyc?.status || "not_submitted", kyc: kyc || null },
    });
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

    const kyc = await Kyc.findOne({ sellerId: req.params.id });
    if (!kyc) {
      return res.status(404).json({ success: false, message: "No KYC submission found for this seller" });
    }

    const before = kyc.status;

    kyc.status     = status;
    kyc.adminNote  = note || "";
    kyc.reviewedAt = new Date();
    kyc.reviewedBy = req.seller?.name || "Admin";
    await kyc.save();

    // Keep the cached status on Seller in sync
    seller.kycStatus = status;
    if (status === "approved" && seller.status === "pending") {
      seller.status = "active";
    }
    await seller.save();

    await logAction(req, {
      action:      "STATUS_CHANGE",
      entity:      "Kyc",
      entityId:    kyc._id,
      entityRef:   seller.name,
      description: `KYC for ${seller.name} (${seller.email}): ${before} → ${status}${note ? ` — "${note}"` : ""}`,
      before:      { status: before },
      after:       { status },
    });

    res.json({
      success: true,
      message: `KYC ${status.replace("_", " ")}`,
      seller: { ...seller.toObject(), kycStatus: status, kyc },
    });
  } catch (err) {
    console.error("[admin/sellers kyc update]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// PATCH /api/admin/sellers/:id/status
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
