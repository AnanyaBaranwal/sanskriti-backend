const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const Seller = require("../models/Seller.model");
const { sendVerificationEmail } = require("../services/email.service");

// ─── Helpers ────────────────────────────────────────────────────────────────

const generateAccessToken = (id, role) => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "15m",
  });
};

const generateRefreshToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  });
};

const sendTokenResponse = async (seller, statusCode, res) => {
  const accessToken = generateAccessToken(seller._id, seller.role);
  const refreshToken = generateRefreshToken(seller._id);

  // Save refresh token to DB so we can validate + invalidate it
  await Seller.findByIdAndUpdate(seller._id, { refreshToken });

  // Set refresh token as httpOnly cookie
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.status(statusCode).json({
    success: true,
    accessToken,
    seller,
  });
};
// ─── Controllers ────────────────────────────────────────────────────────────

// POST /api/auth/register
exports.register = async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    // Basic validation
    if (!name || !email || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: "All fields are required: name, email, phone, password",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    // Check duplicate email
    const existing = await Seller.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists",
      });
    }

    // Generate email verification token
    const emailVerifyToken = crypto.randomBytes(32).toString("hex");
    const emailVerifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // Create seller (passwordHash field triggers bcrypt in pre-save hook)
    const seller = await Seller.create({
      name,
      email,
      phone,
      passwordHash: password,
      emailVerifyToken,
      emailVerifyExpires,
    });

    // Send verification email (non-blocking — don't fail registration if email fails)
    try {
      await sendVerificationEmail(seller.email, seller.name, emailVerifyToken);
    } catch (emailErr) {
      console.error("Verification email failed:", emailErr.message);
    }

    sendTokenResponse(seller, 201, res);
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ success: false, message: "Server error during registration" });
  }
};

// POST /api/auth/login
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    // Fetch seller including passwordHash (it's select:false on the model)
    const seller = await Seller.findOne({ email: email.toLowerCase() }).select(
      "+passwordHash +refreshToken"
    );

    if (!seller) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const isMatch = await seller.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    if (seller.status === "suspended") {
      return res.status(403).json({
        success: false,
        message: "Your account has been suspended. Contact support.",
      });
    }

    sendTokenResponse(seller, 200, res);
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, message: "Server error during login" });
  }
};

// POST /api/auth/logout
exports.logout = async (req, res) => {
  try {
    // Clear refresh token from DB
    await Seller.findByIdAndUpdate(req.seller.id, { refreshToken: "" });

    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    });

    res.status(200).json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error during logout" });
  }
};

// GET /api/auth/me — get current logged-in seller
exports.getMe = async (req, res) => {
  try {
    const seller = await Seller.findById(req.seller.id);
    if (!seller) {
      return res.status(404).json({ success: false, message: "Seller not found" });
    }
    res.status(200).json({ success: true, seller });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/auth/verify-email/:token
exports.verifyEmail = async (req, res) => {
  try {
    const seller = await Seller.findOne({
      emailVerifyToken: req.params.token,
      emailVerifyExpires: { $gt: Date.now() },
    });

    if (!seller) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired verification token",
      });
    }

    seller.isEmailVerified = true;
    seller.emailVerifyToken = undefined;
    seller.emailVerifyExpires = undefined;
    seller.status = "active";
    await seller.save({ validateBeforeSave: false });

    res.status(200).json({ success: true, message: "Email verified successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── POST /api/auth/refresh-token ────────────────────────────────────────────
// Called automatically by frontend when accessToken expires
exports.refreshToken = async (req, res) => {
  try {
    // Get refresh token from httpOnly cookie
    const token = req.cookies.refreshToken;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "No refresh token. Please login again.",
        code: "NO_REFRESH_TOKEN",
      });
    }

    // Verify the refresh token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    } catch (err) {
      // Refresh token is expired or invalid — force re-login
      res.clearCookie("refreshToken", {
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

    // Find seller and check stored refresh token matches
    const seller = await Seller.findById(decoded.id).select("+refreshToken");

    if (!seller) {
      return res.status(401).json({
        success: false,
        message: "Seller not found. Please login again.",
      });
    }

    // Extra security: check the token in DB matches the cookie
    // This lets us invalidate all sessions by clearing refreshToken in DB
    if (seller.refreshToken !== token) {
      return res.status(401).json({
        success: false,
        message: "Invalid refresh token. Please login again.",
        code: "TOKEN_REUSE_DETECTED",
      });
    }

    // Generate brand new access token
    const newAccessToken = generateAccessToken(seller._id, seller.role);

    // Rotate refresh token — generate a new one and save to DB
    // This means each refresh token can only be used ONCE (more secure)
    const newRefreshToken = generateRefreshToken(seller._id);
    seller.refreshToken = newRefreshToken;
    await seller.save({ validateBeforeSave: false });

    // Set new refresh token cookie
    res.cookie("refreshToken", newRefreshToken, {
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
    console.error("Refresh token error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const seller = await Seller.findOne({ email: email.toLowerCase() });

    // Always return success even if email not found (security — don't reveal emails)
    if (!seller) {
      return res.status(200).json({
        success: true,
        message: "If that email exists, a reset link has been sent.",
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    seller.passwordResetToken = hashedToken;
    seller.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await seller.save({ validateBeforeSave: false });

    // Send reset email
    const resetURL = `${process.env.FRONTEND_URL || "http://localhost:3000"}/reset-password/${resetToken}`;

    try {
      console.log("Sending reset email to:", seller.email);
      console.log("Reset URL:", resetURL);
      await require("../services/email.service").sendPasswordResetEmail(
        seller.email,
        seller.name,
        resetURL
      );
      console.log("Email sent successfully!");
    } catch (emailErr) {
      console.log("Email error:", emailErr.message);
      // If email fails, clear the reset token
      seller.passwordResetToken = undefined;
      seller.passwordResetExpires = undefined;
      await seller.save({ validateBeforeSave: false });

      return res.status(500).json({
        success: false,
        message: "Email could not be sent. Try again.",
      });
    }

    res.status(200).json({
      success: true,
      message: "If that email exists, a reset link has been sent.",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── POST /api/auth/reset-password/:token ────────────────────────────────────
exports.resetPassword = async (req, res) => {
  try {
    const { password } = req.body;

    if (!password || password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    // Hash the token from URL to compare with DB
    const hashedToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    const seller = await Seller.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    }).select("+passwordResetToken +passwordResetExpires");

    if (!seller) {
      return res.status(400).json({
        success: false,
        message: "Reset token is invalid or has expired (10 min limit)",
      });
    }

    // Set new password — pre-save hook will hash it
    seller.passwordHash = password;
    seller.passwordResetToken = undefined;
    seller.passwordResetExpires = undefined;
    seller.refreshToken = undefined; // log out all devices
    await seller.save();

    res.status(200).json({
      success: true,
      message: "Password reset successful. Please login with your new password.",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};