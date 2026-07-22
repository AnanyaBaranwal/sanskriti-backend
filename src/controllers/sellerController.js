const Seller = require("../models/Seller.model");
const { checkSellerEligibility } = require("../utils/sellerEligibility");

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
    // NOTE: "notificationPrefs" added here (previously this tab was purely
    // client-side/mocked — toggles reset on every page load and never
    // reached the backend at all). The frontend always sends the FULL
    // 8-key object when saving, so a plain $set is safe — it replaces the
    // whole sub-document, it doesn't need per-key merging.
    // NOTE: "bankDetails" added here — previously it wasn't in this list
    // (and the field didn't even exist on the Seller schema), so the
    // Profile page's Bank tab was saving nothing at all despite showing
    // a success toast.
    const allowedFields = ["name", "phone", "address", "notificationPrefs", "bankDetails"];
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
    const allowedFields = ["company", "gstNumber", "address"];
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

// ─── GET /api/seller/eligibility ──────────────────────────────────────────────
// Lets the frontend proactively disable the "Recharge Wallet" and "Place
// Order" buttons (with a clear reason) instead of only finding out via a
// 403 after the seller already tried. Reuses the exact same check that
// paymentController.createOrder and orderController.createOrder enforce,
// so the two can never disagree.
exports.getEligibility = async (req, res) => {
  try {
    const eligibility = await checkSellerEligibility(req.seller.id);
    res.status(200).json({ success: true, ...eligibility });
  } catch (error) {
    console.error("Get eligibility error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
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

    if (!seller) {
      return res.status(404).json({
        success: false,
        message: "Seller not found",
      });
    }

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
