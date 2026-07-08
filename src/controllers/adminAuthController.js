// src/controllers/adminAuthController.js
const jwt = require("jsonwebtoken");
const Client = require("../models/Client.model");

const ADMIN_ROLES = ["admin", "manager", "employee"]; // staff roles allowed into the Admin Panel

const generateAccessToken = (id, role) =>
  jwt.sign({ id, role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "15m",
  });

const generateRefreshToken = (id) =>
  jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  });

// ── POST /api/auth/admin-login ────────────────────────────────
// Same credential check as the regular seller login, PLUS a role gate.
// A seller-role account gets a clean 403 here and NEVER receives a token
// for the admin panel — this is what was missing before.
exports.adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const account = await Client.findOne({ email: email.toLowerCase() }).select(
      "+passwordHash +refreshToken"
    );

    if (!account) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const isMatch = await account.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    if (account.status === "suspended") {
      return res.status(403).json({ success: false, message: "Your account has been suspended. Contact support." });
    }

    // ── The actual fix — reject anything that isn't staff ─────────────
    if (!ADMIN_ROLES.includes(account.role)) {
      return res.status(403).json({
        success: false,
        message: "This account does not have access to the Admin Panel.",
      });
    }

    const accessToken = generateAccessToken(account._id, account.role);
    const refreshToken = generateRefreshToken(account._id);

    await Client.findByIdAndUpdate(account._id, { refreshToken });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      success: true,
      accessToken,
      seller: account, // kept as `seller` to match your existing frontend's expected response shape
    });
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ success: false, message: "Server error during login" });
  }
};