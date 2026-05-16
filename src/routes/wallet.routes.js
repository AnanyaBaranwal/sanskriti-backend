const express = require("express");
const router = express.Router();
const {
  getBalance,
  getTransactions,
  credit,
  debit,
  getSummary,
} = require("../controllers/walletController");
const { protect } = require("../middleware/auth.middleware");

// All wallet routes require login
router.use(protect);

router.get("/balance", getBalance);
router.get("/transactions", getTransactions);
router.get("/summary", getSummary);
router.post("/credit", credit);
router.post("/debit", debit);

module.exports = router;