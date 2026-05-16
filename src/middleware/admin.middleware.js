exports.adminOnly = (req, res, next) => {
  if (req.seller.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }
  next();
};