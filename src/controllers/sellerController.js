const Seller = require("../models/kyc.model");
const bcrypt = require("bcryptjs");

// ─── GET /api/seller/profile ──────────────────────────────────────────────────
exports.getProfile = async (req, res) => {
  try {
    const seller = await Seller.findById(req.seller.id);

    if (!seller) {
      return res.status(404).json({
        success: false,
        message: "Seller not found",
      });
    }

    res.status(200).json({
      success: true,
      seller,
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── PATCH /api/seller/profile ────────────────────────────────────────────────
exports.updateProfile = async (req, res) => {
  try {
    // Only allow these fields to be updated — never role, status, passwordHash
    const allowedFields = ["name", "phone", "address", "profilePhoto"];
    const updates = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    // If profile photo was uploaded via multer
    if (req.file) {
      updates.profilePhoto = req.file.path;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided to update",
      });
    }

    const seller = await Seller.findByIdAndUpdate(
      req.seller.id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      seller,
    });
  } catch (error) {
    console.error("Update profile error:", error);
    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: Object.values(error.errors)
          .map((e) => e.message)
          .join(", "),
      });
    }
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── PATCH /api/seller/business ───────────────────────────────────────────────
exports.updateBusiness = async (req, res) => {
  try {
    const allowedFields = ["businessName", "gstNumber", "address"];
    const updates = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided to update",
      });
    }

    const seller = await Seller.findByIdAndUpdate(
      req.seller.id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    res.status(200).json({
      success: true,
      message: "Business details updated successfully",
      seller,
    });
  } catch (error) {
    console.error("Update business error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── GET /api/seller/kyc ──────────────────────────────────────────────────────
exports.getKYC = async (req, res) => {
  try {
    const seller = await Seller.findById(req.seller.id).select(
      "kyc kycStatus"
    );

    res.status(200).json({
      success: true,
      kycStatus: seller.kycStatus,
      kyc: seller.kyc,
    });
  } catch (error) {
    console.error("Get KYC error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── POST /api/seller/kyc/upload ──────────────────────────────────────────────
exports.uploadKYC = async (req, res) => {
  try {
    const {
      panNumber,
      aadharNumber,
      bankAccountNumber,
      bankIFSC,
      bankAccountName,
    } = req.body;

    // Build KYC update object
    const kycUpdate = {};

    if (panNumber) kycUpdate["kyc.panNumber"] = panNumber.toUpperCase();
    if (aadharNumber) kycUpdate["kyc.aadharNumber"] = aadharNumber;
    if (bankAccountNumber)
      kycUpdate["kyc.bankAccountNumber"] = bankAccountNumber;
    if (bankIFSC) kycUpdate["kyc.bankIFSC"] = bankIFSC.toUpperCase();
    if (bankAccountName) kycUpdate["kyc.bankAccountName"] = bankAccountName;

    // Add file paths if documents were uploaded
    if (req.files) {
      if (req.files.panDocument) {
        kycUpdate["kyc.panDocument"] = req.files.panDocument[0].path;
      }
      if (req.files.aadharDocument) {
        kycUpdate["kyc.aadharDocument"] = req.files.aadharDocument[0].path;
      }
      if (req.files.cancelledCheque) {
        kycUpdate["kyc.cancelledCheque"] = req.files.cancelledCheque[0].path;
      }
    }

    // Mark KYC as submitted
    kycUpdate["kyc.submittedAt"] = new Date();
    kycUpdate["kycStatus"] = "under_review";

    const seller = await Seller.findByIdAndUpdate(
      req.seller.id,
      { $set: kycUpdate },
      { new: true }
    );

    res.status(200).json({
      success: true,
      message: "KYC submitted successfully. Under review.",
      kycStatus: seller.kycStatus,
      kyc: seller.kyc,
    });
  } catch (error) {
    console.error("KYC upload error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── PATCH /api/seller/change-password ───────────────────────────────────────
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters",
      });
    }

    // Fetch seller with password
    const seller = await Seller.findById(req.seller.id).select("+passwordHash");

    const isMatch = await seller.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    // Update password — pre-save hook will hash it
    seller.passwordHash = newPassword;
    seller.refreshToken = undefined; // logout all devices
    await seller.save();

    res.status(200).json({
      success: true,
      message: "Password changed successfully. Please login again.",
    });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};