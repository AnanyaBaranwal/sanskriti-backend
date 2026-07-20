const express = require("express");
const router = express.Router();
const {
  register,
  login,
  logout,
  getMe,
  verifyEmail,
  refreshToken,
  forgotPassword,
  resetPassword,
} = require("../controllers/authController");
const { protect } = require("../middleware/auth.middleware");

const {
  adminLogin,
  refreshStaffToken,
  adminLogout,
  getStaffMe,
} = require("../controllers/adminAuthController");
const { protectStaff } = require("../middleware/staffAuth.middleware");

// ── Public routes (no token needed) ──────────────────────────
router.post("/register", register);
router.post("/login", login);
router.get("/verify-email/:token", verifyEmail);
router.post("/refresh-token", refreshToken);       // seller — uses "refreshToken" cookie
router.post("/forgot-password", forgotPassword);
router.post("/reset-password/:token", resetPassword);

// ── Staff / Admin Panel routes ────────────────────────────────
// Completely separate from the seller routes above — different
// collection (Staff), different cookie name (staffRefreshToken),
// different token-refresh logic.
router.post("/admin-login", adminLogin);
router.post("/staff-refresh-token", refreshStaffToken); // uses "staffRefreshToken" cookie
router.post("/admin-logout", protectStaff, adminLogout);
router.get("/staff-me", protectStaff, getStaffMe);

// ── Protected seller routes (valid access token required) ─────
router.post("/logout", protect, logout);
router.get("/me", protect, getMe);

module.exports = router;
