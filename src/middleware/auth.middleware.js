const jwt = require("jsonwebtoken");
const Seller = require("../models/kyc.model");

// Verify access token from Authorization header
exports.protect = async (req, res, next) => {
  try {
    let token;

    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer ")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Access denied. No token provided.",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const seller = await Seller.findById(decoded.id);
    if (!seller) {
      return res.status(401).json({
        success: false,
        message: "Token is valid but seller no longer exists",
      });
    }

    if (seller.status === "suspended") {
      return res.status(403).json({
        success: false,
        message: "Your account has been suspended",
      });
    }

    req.seller = { id: seller._id, role: seller.role, email: seller.email };
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Token expired",
        code: "TOKEN_EXPIRED",
      });
    }
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Restrict to specific roles — use after protect
// Usage: router.get('/admin/...', protect, restrictTo('admin'), handler)
exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.seller.role)) {
      return res.status(403).json({
        success: false,
        message: `Role '${req.seller.role}' is not authorized for this route`,
      });
    }
    next();
  };
};