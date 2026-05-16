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

// ── Public routes (no token needed) ──────────────────────────
router.post("/register", register);
router.post("/login", login);
router.get("/verify-email/:token", verifyEmail);
router.post("/refresh-token", refreshToken);       // uses httpOnly cookie
router.post("/forgot-password", forgotPassword);
router.post("/reset-password/:token", resetPassword);

// ── Protected routes (valid access token required) ────────────
router.post("/logout", protect, logout);
router.get("/me", protect, getMe);

module.exports = router;