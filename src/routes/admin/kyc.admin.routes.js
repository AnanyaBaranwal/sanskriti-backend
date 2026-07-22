const express  = require("express");
const router   = express.Router();
const fs       = require("fs");
const path     = require("path");

const Seller = require("../../models/Seller.model");
const Kyc    = require("../../models/Kyc.model");
const { protectStaff, restrictStaffTo } = require("../../middleware/staffAuth.middleware");
const { logAction } = require("../../utils/audit");
const { uploadKYCAdmin } = require("../../middleware/upload.middleware");

router.use(protectStaff, restrictStaffTo("admin"));

const VALID_KYC_STATUSES = ["not_submitted", "under_review", "approved", "rejected"];
const KYC_DOC_FIELDS = ["panDocument", "aadharDocument", "cancelledCheque", "businessDocument", "selfieDocument"];

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

    const generatedPassword = !password;
    const tempPassword = password || Math.random().toString(36).slice(-10);

    const seller = await Seller.create({
      name,
      email: email.toLowerCase(),
      phone,
      passwordHash: tempPassword,
      role: "seller",
      status: "active",
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
//
// KYC status priority ordering: sellers whose KYC needs admin attention
// float to the top — Under Review first, then Not Submitted, then
// Rejected, and finally Approved (already decided, lowest priority to see
// again) at the bottom. Within each group, newest-first is preserved.
//
// This can't be a single Mongo-level sort because kycStatus doesn't live
// on the Seller document — it's in a separate Kyc collection — so instead
// we fetch all matching sellers, attach each one's kycStatus, sort by
// priority in JS, and paginate the already-sorted array. Fine at the scale
// of a single-business admin panel; would need revisiting (e.g. a
// denormalized kycStatus field on Seller, kept in sync on write) if the
// seller count ever grows into the thousands+.
router.get("/", async (req, res) => {
  try {
    const {
      search, kycStatus,
      page = 1, limit = 20,
      includeAdmins = "false",
    } = req.query;

    const baseFilter = {};
    if (includeAdmins !== "true") baseFilter.role = { $ne: "admin" };

    let sellerIdFilter = null;
    if (kycStatus && VALID_KYC_STATUSES.includes(kycStatus)) {
      if (kycStatus === "not_submitted") {
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

    // Fetch every matching seller (unpaginated) so KYC-priority sorting can
    // be applied across the whole result set before slicing a page out.
    const [allMatching, total] = await Promise.all([
      Seller.find(filter).sort({ createdAt: -1 }).lean(),
      Seller.countDocuments(filter),
    ]);

    const sellerIds = allMatching.map(s => s._id);
    const kycDocs = await Kyc.find({ sellerId: { $in: sellerIds } }).lean();
    const kycBySellerId = {};
    kycDocs.forEach(k => { kycBySellerId[k.sellerId.toString()] = k; });

    const withStatus = allMatching.map(s => ({
      ...s,
      kycStatus: kycBySellerId[s._id.toString()]?.status || "not_submitted",
      kyc: kycBySellerId[s._id.toString()] || null,
    }));

    const PRIORITY = { under_review: 0, not_submitted: 1, rejected: 2, approved: 3 };
    // Array.prototype.sort is stable in modern JS engines, so the
    // newest-first order from the DB query is preserved within each
    // priority group.
    withStatus.sort((a, b) => (PRIORITY[a.kycStatus] ?? 99) - (PRIORITY[b.kycStatus] ?? 99));

    const start = (Number(page) - 1) * Number(limit);
    const sellers = withStatus.slice(start, start + Number(limit));

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

    // Rejection must always come with a reason — this is what the seller
    // sees on their Documents tab so they know what to fix before
    // re-submitting. Enforced here so it can't be skipped even if the
    // frontend form validation is ever bypassed or changes.
    if (status === "rejected" && !note?.trim()) {
      return res.status(400).json({
        success: false,
        message: "A rejection reason is required when rejecting KYC.",
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
    kyc.reviewedBy = req.staff?.name || "Admin";
    // NOTE: rejection deliberately does NOT touch any uploaded documents.
    // The seller sees "Rejected" + this admin note on their Documents tab
    // and must manually remove/replace files themselves, then resubmit —
    // nothing is auto-cleared here.
    await kyc.save();

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
      if (req.files.panDocument)      kyc.panDocument      = req.files.panDocument[0].path;
      if (req.files.aadharDocument)   kyc.aadharDocument   = req.files.aadharDocument[0].path;
      if (req.files.cancelledCheque)  kyc.cancelledCheque  = req.files.cancelledCheque[0].path;
      if (req.files.businessDocument) kyc.businessDocument = req.files.businessDocument[0].path;
      if (req.files.selfieDocument)   kyc.selfieDocument   = req.files.selfieDocument[0].path;
    }

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

    seller.passwordHash = newPassword;
    seller.refreshToken = undefined;
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
