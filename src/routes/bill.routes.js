const express = require("express");
const router  = express.Router();
const { getBills, getBillById, downloadBill } = require("../controllers/billController");
const { protect } = require("../middleware/auth.middleware");

// Sellers can only view and download bills admin generated for them.
// Generation lives entirely under /api/admin/bills (admin-only).
router.use(protect);

router.get("/", getBills);
router.get("/:id", getBillById);
router.get("/:id/download", downloadBill);

module.exports = router;