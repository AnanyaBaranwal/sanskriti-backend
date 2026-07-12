const express = require("express");
const router = express.Router();
const {
  getBalance,
  getTransactions,
  credit,
  debit,
  getSummary,
  getClientWallet,
} = require("../controllers/walletController");
const { protect, restrictTo } = require("../middleware/auth.middleware");

// All wallet routes require login
router.use(protect);

// Seller wallet (existing)
router.get("/balance", getBalance);
router.get("/transactions", getTransactions);
router.get("/summary", getSummary);
router.post("/credit", credit);
router.post("/debit", debit);

// Seller wallet — NEW, admin-only (clients don't log in themselves)
router.get("/clients/:clientId/wallet", restrictTo("admin"), getClientWallet);

module.exports = router;
