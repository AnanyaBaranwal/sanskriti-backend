const express   = require("express");
const router    = express.Router();
const AuditLog  = require("../../models/AuditLog.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");

router.use(protect, restrictTo("admin"));

// ── GET /api/admin/audit-logs ─────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const {
      entity, action, performedBy,
      from, to,
      page = 1, limit = 30,
    } = req.query;

    const filter = {};
    if (entity)      filter.entity      = entity;
    if (action)      filter.action      = action;
    if (performedBy) filter.performedBy = performedBy;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to)   filter.createdAt.$lte = new Date(to);
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.json({
      success: true,
      total,
      page:  Number(page),
      pages: Math.ceil(total / limit),
      logs,
    });
  } catch (err) {
    console.error("[audit-logs]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
