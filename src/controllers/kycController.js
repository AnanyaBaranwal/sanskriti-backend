const Kyc = require("../models/kyc.model");

// ─── GET /api/seller/kyc ──────────────────────────────────────────────────────
// Reads from the standalone Kyc collection — nothing here touches Seller.
exports.getKYC = async (req, res) => {
  try {
    const kyc = await Kyc.findOne({ sellerId: req.seller.id });

    res.status(200).json({
      success: true,
      kycStatus: kyc?.status || "not_submitted",
      kyc: kyc || null,
    });
  } catch (error) {
    console.error("Get KYC error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── POST /api/seller/kyc/upload ──────────────────────────────────────────────
// Writes only to the standalone Kyc collection — nothing here touches Seller.
exports.uploadKYC = async (req, res) => {
  try {
    const {
      panNumber,
      aadharNumber,
      bankAccountNumber,
      bankIFSC,
      bankAccountName,
    } = req.body;

    const update = { $set: { submittedAt: new Date(), status: "under_review" } };

    if (panNumber) update.$set.panNumber = panNumber.toUpperCase();
    if (aadharNumber) update.$set.aadharNumber = aadharNumber;
    if (bankAccountNumber) update.$set.bankAccountNumber = bankAccountNumber;
    if (bankIFSC) update.$set.bankIFSC = bankIFSC.toUpperCase();
    if (bankAccountName) update.$set.bankAccountName = bankAccountName;

    // Add file paths if documents were uploaded
    if (req.files) {
      if (req.files.panDocument) {
        update.$set.panDocument = req.files.panDocument[0].path;
      }
      if (req.files.aadharDocument) {
        update.$set.aadharDocument = req.files.aadharDocument[0].path;
      }
      if (req.files.cancelledCheque) {
        update.$set.cancelledCheque = req.files.cancelledCheque[0].path;
      }
    }

    const kyc = await Kyc.findOneAndUpdate(
      { sellerId: req.seller.id },
      { $setOnInsert: { sellerId: req.seller.id }, ...update },
      { upsert: true, new: true }
    );

    res.status(200).json({
      success: true,
      message: "KYC submitted successfully. Under review.",
      kycStatus: kyc.status,
      kyc,
    });
  } catch (error) {
    console.error("KYC upload error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
