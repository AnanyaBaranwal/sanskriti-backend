const express = require("express");
const router = express.Router();
const {
  createOrder,
  verifyPayment,
  webhook,
  getPaymentHistory,
} = require("../controllers/paymentController");
const { protect } = require("../middleware/auth.middleware");

// Webhook — NO auth (Razorpay calls this directly)
// Must use raw body for signature verification
router.post("/webhook", express.raw({ type: "application/json" }), webhook);

// Protected routes
router.use(protect);
router.post("/create-order", createOrder);
router.post("/verify", verifyPayment);
router.get("/history", getPaymentHistory);

module.exports = router;