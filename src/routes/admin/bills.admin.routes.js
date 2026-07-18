const express = require("express");
const router  = express.Router();
const {
  listSellers,
  listOrdersForBilling,
  getOrderForBilling,
  getBillingStats,
  createManualBill,
  createBillFromOrder,
  getAllBills,
  getBillByIdAdmin,
  downloadBillPdf,
  updateBill,
  updatePaymentStatusAdmin,
  deleteBill,
  exportBills,
} = require("../../controllers/adminBillController");
const { protect, restrictTo } = require("../../middleware/auth.middleware");

router.use(protect, restrictTo("admin"));

// Static/literal paths MUST come before the "/:id" catch-all route below,
// otherwise Express matches them as an :id parameter instead.
router.get("/sellers",              listSellers);
router.get("/orders",               listOrdersForBilling);
router.get("/order/:orderId",       getOrderForBilling);
router.get("/stats",                getBillingStats);
router.get("/export",               exportBills);
router.post("/generate",            createManualBill);
router.post("/generate-from-order", createBillFromOrder);
router.get("/",                     getAllBills);

router.get("/:id",                  getBillByIdAdmin);
router.get("/:id/pdf",              downloadBillPdf);
router.patch("/:id",                updateBill);
router.patch("/:id/payment",        updatePaymentStatusAdmin);
router.delete("/:id",               deleteBill);

module.exports = router;
