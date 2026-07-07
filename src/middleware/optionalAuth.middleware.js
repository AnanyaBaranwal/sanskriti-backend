const jwt = require("jsonwebtoken");
const Client = require("../models/Client.model");

// Like `protect`, but never rejects the request. If a valid token is present,
// req.seller is populated (so controllers can decide to reveal cost prices);
// if not, req.seller stays undefined and the request proceeds as a guest.
exports.optionalAuth = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
      token = req.headers.authorization.split(" ")[1];
    }
    if (!token) return next();

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const client = await Client.findById(decoded.id);
    if (client && client.status !== "suspended") {
      req.seller = { id: client._id, role: client.role, email: client.email };
    }
    next();
  } catch (err) {
    // Invalid/expired token on a public route — just treat as guest.
    next();
  }
};
