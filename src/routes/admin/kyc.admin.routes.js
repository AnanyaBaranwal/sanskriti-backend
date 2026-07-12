const express  = require("express");
const router   = express.Router();
const fs       = require("fs");
const path     = require("path");

const Seller = require("../../models/Seller.model");
const Kyc    = require("../../models/kyc.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");
const { logAction } = require("../../utils/audit");
const { uploadKYCAdmin } = require("../../middleware/upload.middleware");

router.use(protect, restrictTo("admin"));

const VALID_KYC_STATUSES = ["not_submitted", "under_review", "approved", "rejected"];
const KYC_DOC_FIELDS = ["panDocument", "aadharDocument", "cancelledCheque"];

// POST /api/admin/sellers — admin manually creates a new seller account
router.post("/", async (req, res) => {
  try {
    const { name, email, phone, password, businessName, gstNumber } = req.body;

    if (!name || !email || !phone) {
      return res.status(400).json({ success: false, message: "Name, email and phone are required" });
    }

    const exists = await Seller.findOne({ email: email.toLowerCase() });
    if (exists) {
      return res.status(409).json({ success: false, message: "A seller with this email already exists" });
    }

    // If no password given, generate one so the admin can hand it to the seller.
    // Seller.model.js's pre-save hook hashes passwordHash automatically — pass
    // the plain value here, do NOT hash it manually or it'll be double-hashed.
    const generatedPassword = !password;
    const tempPassword = password || Math.random().toString(36).slice(-10);

    const seller = await Seller.create({
      name,
      email: email.toLowerCase(),
      phone,
      passwordHash: tempPassword,
      role: "seller",
      status: "active", // manually added sellers are active immediately
      businessName: businessName || "",
      gstNumber: gstNumber || "",
    });

    await logAction(req, {
      action: "CREATE",
      entity: "Seller",
      entityId: seller._id,
      entityRef: seller.name,
      description: `Admin created seller account for ${seller.name} (${seller.email})`,
    });

    res.status(201).json({
      success: true,
      message: "Seller created successfully",
      seller: { ...seller.toObject(), kycStatus: "not_submitted", kyc: null },
      // Only sent back when we generated it ourselves, so the admin can share
      // it with the seller. Never returned if the admin set their own password.
      tempPassword: generatedPassword ? tempPassword : undefined,
    });
  } catch (err) {
    console.error("[admin/sellers create]", err);
    if (err.name === "ValidationError") {
      return res.status(400).json({ success: false, message: Object.values(err.errors).map(e => e.message).join(", ") });
    }
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: "A seller with this email already exists" });
    }
    res.status(500).json({ success: false, message: "Server error" });
  }
});

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

// PATCH /api/admin/sellers/:id/kyc — approve / reject
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

    // NOTE: Seller.kycStatus is intentionally NOT written here — KYC status
    // lives only in the Kyc collection. Only the account-activation flag on
    // Seller is touched, since that's account state, not KYC data.
    if (status === "approved" && seller.status === "pending") {
      seller.status = "active";
      await seller.save();
    }

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

// POST /api/admin/sellers/:id/kyc/upload — admin uploads/replaces documents for a seller
router.post("/:id/kyc/upload", uploadKYCAdmin, async (req, res) => {
  try {
    const seller = await Seller.findById(req.params.id);
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });

    const { panNumber, aadharNumber, bankAccountNumber, bankIFSC, bankAccountName } = req.body;

    let kyc = await Kyc.findOne({ sellerId: req.params.id });
    if (!kyc) kyc = new Kyc({ sellerId: req.params.id });

    if (panNumber)         kyc.panNumber         = panNumber.toUpperCase();
    if (aadharNumber)      kyc.aadharNumber       = aadharNumber;
    if (bankAccountNumber) kyc.bankAccountNumber  = bankAccountNumber;
    if (bankIFSC)          kyc.bankIFSC           = bankIFSC.toUpperCase();
    if (bankAccountName)   kyc.bankAccountName    = bankAccountName;

    if (req.files) {
      if (req.files.panDocument)     kyc.panDocument     = req.files.panDocument[0].path;
      if (req.files.aadharDocument)  kyc.aadharDocument  = req.files.aadharDocument[0].path;
      if (req.files.cancelledCheque) kyc.cancelledCheque = req.files.cancelledCheque[0].path;
    }

    // Documents changed by an admin — surface for review instead of leaving
    // a stale not_submitted/rejected status in place.
    if (["not_submitted", "rejected"].includes(kyc.status)) {
      kyc.status = "under_review";
      kyc.submittedAt = new Date();
    }
    await kyc.save();

    await logAction(req, {
      action:      "UPDATE",
      entity:      "Kyc",
      entityId:    kyc._id,
      entityRef:   seller.name,
      description: `Admin uploaded/updated KYC documents for ${seller.name}`,
    });

    res.json({
      success: true,
      message: "KYC documents updated",
      seller: { ...seller.toObject(), kycStatus: kyc.status, kyc },
    });
  } catch (err) {
    console.error("[admin/sellers kyc upload]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// DELETE /api/admin/sellers/:id/kyc/document/:docType
router.delete("/:id/kyc/document/:docType", async (req, res) => {
  try {
    const { docType } = req.params;
    if (!KYC_DOC_FIELDS.includes(docType)) {
      return res.status(400).json({ success: false, message: `Invalid document type. Valid: ${KYC_DOC_FIELDS.join(", ")}` });
    }

    const kyc = await Kyc.findOne({ sellerId: req.params.id });
    if (!kyc || !kyc[docType]) {
      return res.status(400).json({ success: false, message: "No document to remove" });
    }

    // Best-effort file deletion — don't fail the request if the file is already gone
    try {
      const absolute = path.resolve(kyc[docType]);
      if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
    } catch (fileErr) {
      console.warn("[admin/sellers kyc document delete] file removal failed:", fileErr.message);
    }

    kyc[docType] = undefined;
    await kyc.save();

    await logAction(req, {
      action:      "UPDATE",
      entity:      "Kyc",
      entityId:    kyc._id,
      description: `Admin removed ${docType} for seller ${req.params.id}`,
    });

    res.json({ success: true, message: "Document removed", kyc });
  } catch (err) {
    console.error("[admin/sellers kyc document delete]", err);
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

// PATCH /api/admin/sellers/:id/reset-password
// Admin resets a seller's password. If no password is supplied, one is
// generated and returned so the admin can share it with the seller.
// Sets seller.passwordHash to plain text and calls .save() — Seller.model.js's
// pre-save hook hashes it automatically. Never hash it manually here.
router.patch("/:id/reset-password", async (req, res) => {
  try {
    const { password } = req.body;

    const seller = await Seller.findById(req.params.id);
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });

    if (password && password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    }

    const generatedPassword = !password;
    const newPassword = password || Math.random().toString(36).slice(-10);

    seller.passwordHash = newPassword; // pre-save hook hashes this
    seller.refreshToken = undefined;   // force logout on all devices
    await seller.save();

    await logAction(req, {
      action: "UPDATE",
      entity: "Seller",
      entityId: seller._id,
      entityRef: seller.name,
      description: `Admin reset password for ${seller.name} (${seller.email})`,
    });

    res.json({
      success: true,
      message: "Password reset successfully",
      tempPassword: generatedPassword ? newPassword : undefined,
    });
  } catch (err) {
    console.error("[admin/sellers reset-password]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});
module.exports = router;
