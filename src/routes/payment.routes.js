const express = require("express");
const router = express.Router();
const {
  createOrder,
  verifyPayment,
  getPaymentHistory,
} = require("../controllers/paymentController");
const { protect } = require("../middleware/auth.middleware");

// NOTE: /webhook is NOT here anymore — it's mounted directly in app.js
// BEFORE the global express.json() parser, because it needs the raw
// request body to verify Razorpay's signature.

router.use(protect);
router.post("/create-order", createOrder);
router.post("/verify", verifyPayment);
router.get("/history", getPaymentHistory);

module.exports = router;