const express = require("express");
const router = express.Router();
const {
  createOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
  updateOrder,
  deleteOrder,
  getOrderStats,
} = require("../controllers/orderController");
const { protect } = require("../middleware/auth.middleware");

router.use(protect);

router.get("/stats/summary", getOrderStats);
router.get("/", getOrders);
router.post("/", createOrder);
router.get("/:id", getOrderById);
router.patch("/:id/status", updateOrderStatus);
router.patch("/:id", updateOrder);
router.delete("/:id", deleteOrder);

module.exports = router;
