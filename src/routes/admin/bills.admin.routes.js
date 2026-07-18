const express = require("express");
const router  = express.Router();
const {
  listSellers,
  listOrdersForBilling,
  getOrderForBilling,
  createManualBill,
  createBillFromOrder,
  getAllBills,
  getBillByIdAdmin,
  updatePaymentStatusAdmin,
  deleteBill,
  exportBills,
} = require("../../controllers/adminBillController");
const { protect, restrictTo } = require("../../middleware/auth.middleware");

router.use(protect, restrictTo("admin"));

router.get("/sellers",              listSellers);
router.get("/orders",               listOrdersForBilling);
router.get("/order/:orderId",       getOrderForBilling);
router.get("/export",               exportBills);
router.post("/generate",            createManualBill);
router.post("/generate-from-order", createBillFromOrder);
router.get("/",                     getAllBills);
router.get("/:id",                  getBillByIdAdmin);
router.patch("/:id/payment",        updatePaymentStatusAdmin);
router.delete("/:id",               deleteBill);

module.exports = router;
