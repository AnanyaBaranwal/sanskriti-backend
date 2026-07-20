const jwt = require("jsonwebtoken");
const Staff = require("../models/Staff.model");
const { hasPermission } = require("../config/permissions");

exports.protectStaff = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.split(" ")[1];
    }
    if (!token) {
      return res.status(401).json({ success: false, message: "Access denied. No token provided." });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const staff = await Staff.findById(decoded.id);
    if (!staff) {
      return res.status(401).json({ success: false, message: "Token is valid but account no longer exists" });
    }
    if (staff.status === "suspended") {
      return res.status(403).json({ success: false, message: "Your account has been suspended" });
    }

    req.staff = { id: staff._id, role: staff.role, email: staff.email, name: staff.name };
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Token expired", code: "TOKEN_EXPIRED" });
    }
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ success: false, message: "Invalid token" });
    }
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Hard role check — e.g. restrictStaffTo("admin") for admin-only routes
exports.restrictStaffTo = (...roles) => (req, res, next) => {
  if (!roles.includes(req.staff.role)) {
    return res.status(403).json({ success: false, message: `Role '${req.staff.role}' is not authorized for this route` });
  }
  next();
};

// Module-based check — e.g. requireModule("billing")
exports.requireModule = (moduleName) => (req, res, next) => {
  if (!hasPermission(req.staff.role, moduleName)) {
    return res.status(403).json({
      success: false,
      message: `Access denied: '${req.staff.role}' role cannot access '${moduleName}'`,
    });
  }
  next();
};
