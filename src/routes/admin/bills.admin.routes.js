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
const { protectStaff, requireModule, restrictStaffTo } = require("../../middleware/staffAuth.middleware");

// "Billing" module — manager only, per role table (plus admin via "*")
router.use(protectStaff, requireModule("billing"));

// Static/literal paths MUST come before the "/:id" catch-all route below,
// otherwise Express matches them as an :id parameter instead.
router.get("/sellers",              listSellers);
router.get("/orders",               listOrdersForBilling);
router.get("/order/:orderId",       getOrderForBilling);
router.get("/stats",                getBillingStats);
router.get("/export",               exportBills);
router.post("/generate",            createManualBill);

// Admin-only: this is the ONLY route that confirms an order and debits
// the seller's wallet (see createBillFromOrder in adminBillController.js).
// Manager and employee pass requireModule("billing") above, but must be
// blocked specifically here — generating an invoice from an order is a
// financial action, not a routine billing task.
router.post("/generate-from-order", restrictStaffTo("admin"), createBillFromOrder);

router.get("/",                     getAllBills);

router.get("/:id",                  getBillByIdAdmin);
router.get("/:id/pdf",              downloadBillPdf);
router.patch("/:id",                updateBill);
router.patch("/:id/payment",        updatePaymentStatusAdmin);
router.delete("/:id",               deleteBill);

module.exports = router;
