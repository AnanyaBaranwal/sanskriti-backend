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

    // Separate cookie name from the seller's "refreshToken" cookie —
    // prevents a staff session and a seller session on the same browser
    // from overwriting each other's refresh cookie.
    res.cookie("staffRefreshToken", refreshToken, {
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

// ── POST /api/auth/staff-refresh-token ────────────────────────
// Staff-only refresh — reads the staffRefreshToken cookie and checks
// against the Staff collection. Completely separate from the seller's
// /api/auth/refresh-token, which stays untouched and keeps checking Seller.
exports.refreshStaffToken = async (req, res) => {
  try {
    const token = req.cookies.staffRefreshToken;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "No refresh token. Please login again.",
        code: "NO_REFRESH_TOKEN",
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    } catch (err) {
      res.clearCookie("staffRefreshToken", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
      });
      return res.status(401).json({
        success: false,
        message: "Refresh token expired. Please login again.",
        code: "REFRESH_TOKEN_EXPIRED",
      });
    }

    const staff = await Staff.findById(decoded.id).select("+refreshToken");

    if (!staff) {
      return res.status(401).json({
        success: false,
        message: "Account not found. Please login again.",
      });
    }

    if (staff.refreshToken !== token) {
      return res.status(401).json({
        success: false,
        message: "Invalid refresh token. Please login again.",
        code: "TOKEN_REUSE_DETECTED",
      });
    }

    const newAccessToken = generateAccessToken(staff._id, staff.role);
    const newRefreshToken = generateRefreshToken(staff._id);

    staff.refreshToken = newRefreshToken;
    await staff.save();

    res.cookie("staffRefreshToken", newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      success: true,
      accessToken: newAccessToken,
    });
  } catch (error) {
    console.error("Staff refresh token error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── POST /api/auth/admin-logout ───────────────────────────────
exports.adminLogout = async (req, res) => {
  try {
    if (req.staff?.id) {
      await Staff.findByIdAndUpdate(req.staff.id, { refreshToken: "" });
    }
    res.clearCookie("staffRefreshToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    });
    res.status(200).json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error during logout" });
  }
};

// ── GET /api/auth/staff-me ────────────────────────────────────
// This is the endpoint the admin panel's post-login "who am I" check
// should call — NOT /api/seller/profile or /api/auth/me, which only
// know about the Seller collection.
exports.getStaffMe = async (req, res) => {
  try {
    const staff = await Staff.findById(req.staff.id);
    if (!staff) {
      return res.status(404).json({ success: false, message: "Account not found" });
    }
    res.status(200).json({ success: true, staff });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};
