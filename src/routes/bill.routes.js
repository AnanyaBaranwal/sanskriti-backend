const express = require("express");
const router  = express.Router();
const { getBills, getBillById, downloadBill } = require("../controllers/billController");
const { protect } = require("../middleware/auth.middleware");

router.use(protect);
router.get("/", getBills);
router.get("/:id", getBillById);
router.get("/:id/download", downloadBill);

module.exports = router;