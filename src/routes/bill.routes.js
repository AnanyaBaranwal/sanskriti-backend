const express = require("express");
const router = express.Router();
const {
  generateBill,
  getBills,
  getBillById,
  downloadBill,
  updatePaymentStatus,
} = require("../controllers/billController");
const { protect } = require("../middleware/auth.middleware");

router.use(protect);

router.get("/", getBills);
router.post("/generate/:orderId", generateBill);
router.get("/:id", getBillById);
router.get("/:id/download", downloadBill);
router.patch("/:id/payment", updatePaymentStatus);

module.exports = router;
