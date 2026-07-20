const jwt = require("jsonwebtoken");
const Staff = require("../models/Staff.model");

const generateAccessToken = (id, role) =>
  jwt.sign({ id, role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "15m",
  });

const generateRefreshToken = (id) =>
  jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  });

// ── POST /api/auth/admin-login ────────────────────────────────
// Checks credentials against the Staff collection only. Sellers can
// never authenticate here — they simply won't exist in this collection.
exports.adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const account = await Staff.findOne({ email: email.toLowerCase() }).select(
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

    const accessToken = generateAccessToken(account._id, account.role);
    const refreshToken = generateRefreshToken(account._id);

    await Staff.findByIdAndUpdate(account._id, { refreshToken });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      success: true,
      accessToken,
      staff: account,
    });
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ success: false, message: "Server error during login" });
  }
};
