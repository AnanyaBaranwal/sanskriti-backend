const express = require("express");
const router  = express.Router();
const Notification = require("../models/Notification.model");
const { protect } = require("../middleware/auth.middleware");

router.use(protect);

// ── GET /api/notifications?page=&limit=&type= ────────────────
router.get("/", async (req, res) => {
  try {
    const { page = 1, limit = 20, type } = req.query;
    const filter = { sellerId: req.seller.id };
    if (type) filter.type = type.toUpperCase();

    const [notifications, total, unread] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit)),
      Notification.countDocuments(filter),
      Notification.countDocuments({ sellerId: req.seller.id, read: false }),
    ]);

    res.json({
      success: true,
      notifications,
      total,
      unread,
      page: Number(page),
      pages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    console.error("[notifications/list]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/notifications/unread-count ───────────────────────
router.get("/unread-count", async (req, res) => {
  try {
    const unread = await Notification.countDocuments({ sellerId: req.seller.id, read: false });
    res.json({ success: true, unread });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/notifications/:id/read ─────────────────────────
router.patch("/:id/read", async (req, res) => {
  try {
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, sellerId: req.seller.id },
      { read: true },
      { new: true }
    );
    if (!n) return res.status(404).json({ success: false, message: "Notification not found" });
    res.json({ success: true, notification: n });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/notifications/read-all ─────────────────────────
router.patch("/read-all", async (req, res) => {
  try {
    await Notification.updateMany({ sellerId: req.seller.id, read: false }, { read: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── DELETE /api/notifications/clear-read ──────────────────────
// NOTE: must be declared before DELETE "/:id" or Express will treat
// "clear-read" as an :id value.
router.delete("/clear-read", async (req, res) => {
  try {
    await Notification.deleteMany({ sellerId: req.seller.id, read: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── DELETE /api/notifications/:id ─────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const n = await Notification.findOneAndDelete({ _id: req.params.id, sellerId: req.seller.id });
    if (!n) return res.status(404).json({ success: false, message: "Notification not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
