const express = require("express");
const router = express.Router();
const {
  createReturn,
  getAllReturns,
  getReturnById,
  markReceived,
  approveReturn,
  rejectReturn,
  disputeReturn,
} = require("../controllers/returnController");
const { protect, restrictTo } = require("../middleware/auth.middleware");

// All routes require login
router.use(protect);

router.post("/", createReturn);
router.get("/", restrictTo("admin"), getAllReturns);
router.get("/:id", getReturnById);
router.patch("/:id/mark-received", restrictTo("admin"), markReceived);
router.patch("/:id/approve", restrictTo("admin"), approveReturn);
router.patch("/:id/reject", restrictTo("admin"), rejectReturn);
router.patch("/:id/dispute", restrictTo("admin"), disputeReturn);

module.exports = router;
