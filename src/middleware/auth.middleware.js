const jwt = require("jsonwebtoken");
const Client = require("../models/Client.model");

exports.protect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.split(" ")[1];
    }
    if (!token) {
      return res.status(401).json({ success: false, message: "Access denied. No token provided." });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const client = await Client.findById(decoded.id);
    if (!client) {
      return res.status(401).json({ success: false, message: "Token is valid but account no longer exists" });
    }
    if (client.status === "suspended") {
      return res.status(403).json({ success: false, message: "Your account has been suspended" });
    }

    req.seller = { id: client._id, role: client.role, email: client.email };
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

exports.restrictTo = (...roles) => (req, res, next) => {
  if (!roles.includes(req.seller.role)) {
    return res.status(403).json({ success: false, message: `Role '${req.seller.role}' is not authorized for this route` });
  }
  next();
};