const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const Client = require("../models/Client.model");
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

const sendTokenResponse = async (client, statusCode, res) => {
  const accessToken = generateAccessToken(client._id, client.role);
  const refreshToken = generateRefreshToken(client._id);

  await Client.findByIdAndUpdate(client._id, { refreshToken });

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.status(statusCode).json({
    success: true,
    accessToken,
    seller: client, // keep response key "seller" so frontend doesn't need changes
  });
};

// ─── Controllers ────────────────────────────────────────────────────────────

// POST /api/auth/register
exports.register = async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

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

    const existing = await Client.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists",
      });
    }

    const emailVerifyToken = crypto.randomBytes(32).toString("hex");
    const emailVerifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const client = await Client.create({
      name,
      email,
      phone,
      passwordHash: password,
      emailVerifyToken,
      emailVerifyExpires,
    });

    try {
      await sendVerificationEmail(client.email, client.name, emailVerifyToken);
    } catch (emailErr) {
      console.error("Verification email failed:", emailErr.message);
    }

    sendTokenResponse(client, 201, res);
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

    const client = await Client.findOne({ email: email.toLowerCase() }).select(
      "+passwordHash +refreshToken"
    );

    if (!client) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const isMatch = await client.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    if (client.status === "suspended") {
      return res.status(403).json({
        success: false,
        message: "Your account has been suspended. Contact support.",
      });
    }

    sendTokenResponse(client, 200, res);
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, message: "Server error during login" });
  }
};

// POST /api/auth/logout
exports.logout = async (req, res) => {
  try {
    await Client.findByIdAndUpdate(req.seller.id, { refreshToken: "" });

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

// GET /api/auth/me — get current logged-in client
exports.getMe = async (req, res) => {
  try {
    const client = await Client.findById(req.seller.id);
    if (!client) {
      return res.status(404).json({ success: false, message: "Account not found" });
    }
    res.status(200).json({ success: true, seller: client });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/auth/verify-email/:token
exports.verifyEmail = async (req, res) => {
  try {
    const client = await Client.findOne({
      emailVerifyToken: req.params.token,
      emailVerifyExpires: { $gt: Date.now() },
    });

    if (!client) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired verification token",
      });
    }

    client.isEmailVerified = true;
    client.emailVerifyToken = undefined;
    client.emailVerifyExpires = undefined;
    client.status = "active";
    await client.save({ validateBeforeSave: false });

    res.status(200).json({ success: true, message: "Email verified successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── POST /api/auth/refresh-token ────────────────────────────────────────────
exports.refreshToken = async (req, res) => {
  try {
    const token = req.cookies.refreshToken;

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

    const client = await Client.findById(decoded.id).select("+refreshToken");

    if (!client) {
      return res.status(401).json({
        success: false,
        message: "Account not found. Please login again.",
      });
    }

    if (client.refreshToken !== token) {
      return res.status(401).json({
        success: false,
        message: "Invalid refresh token. Please login again.",
        code: "TOKEN_REUSE_DETECTED",
      });
    }

    const newAccessToken = generateAccessToken(client._id, client.role);

    const newRefreshToken = generateRefreshToken(client._id);
    client.refreshToken = newRefreshToken;
    await client.save({ validateBeforeSave: false });

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

    const client = await Client.findOne({ email: email.toLowerCase() });

    if (!client) {
      return res.status(200).json({
        success: true,
        message: "If that email exists, a reset link has been sent.",
      });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    client.passwordResetToken = hashedToken;
    client.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000);
    await client.save({ validateBeforeSave: false });

    const resetURL = `${process.env.FRONTEND_URL || "http://localhost:3000"}/reset-password/${resetToken}`;

    try {
      console.log("Sending reset email to:", client.email);
      console.log("Reset URL:", resetURL);
      await require("../services/email.service").sendPasswordResetEmail(
        client.email,
        client.name,
        resetURL
      );
      console.log("Email sent successfully!");
    } catch (emailErr) {
      console.log("Email error:", emailErr.message);
      client.passwordResetToken = undefined;
      client.passwordResetExpires = undefined;
      await client.save({ validateBeforeSave: false });

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

    const hashedToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    const client = await Client.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    }).select("+passwordResetToken +passwordResetExpires");

    if (!client) {
      return res.status(400).json({
        success: false,
        message: "Reset token is invalid or has expired (10 min limit)",
      });
    }

    client.passwordHash = password;
    client.passwordResetToken = undefined;
    client.passwordResetExpires = undefined;
    client.refreshToken = undefined;
    await client.save();

    res.status(200).json({
      success: true,
      message: "Password reset successful. Please login with your new password.",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};