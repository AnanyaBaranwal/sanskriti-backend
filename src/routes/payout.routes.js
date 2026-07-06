const express = require("express");
const router = express.Router();
const {
  requestPayout,
  getMyPayouts,
  getPayoutById,
  cancelPayout,
  adminGetAllPayouts,
  adminApprovePayout,
  adminRejectPayout,
} = require("../controllers/payoutController");
const { protect, restrictTo } = require("../middleware/auth.middleware");

// All routes require login
router.use(protect);

// Seller routes
router.post("/request", requestPayout);
router.get("/my", getMyPayouts);
router.get("/:id", getPayoutById);
router.delete("/:id/cancel", cancelPayout);

// Admin only routes
// adminGetAllPayouts now also accepts ?type=SELLER_PAYOUT|CLIENT_REFUND
router.get("/admin/all", restrictTo("admin"), adminGetAllPayouts);
router.patch("/admin/:id/approve", restrictTo("admin"), adminApprovePayout);
router.patch("/admin/:id/reject", restrictTo("admin"), adminRejectPayout);

module.exports = router;
