const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");

const Order       = require("../../models/Order.model");
const Wallet       = require("../../models/Wallet.model");
const Transaction  = require("../../models/Transaction.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");
const { logAction } = require("../../utils/audit");

router.use(protect, restrictTo("admin"));

// ── GET /api/admin/refunds/pending ────────────────────────────
// List orders awaiting seller-wallet refund approval
router.get("/pending", async (req, res) => {
  try {
    const orders = await Order.find({ refundStatus: "PENDING" })
      .sort({ updatedAt: -1 })
      .populate("sellerId", "name email")
      .select("orderNumber sellerId buyer.name status total subtotal refundEligibleAmount returnReason statusHistory updatedAt createdAt")
      .lean();

    res.json({ success: true, orders, count: orders.length });
  } catch (err) {
    console.error("[refunds/pending]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/refunds ────────────────────────────────────
// All refunds regardless of status (for history view), optional ?status=
router.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { refundStatus: { $ne: "NONE" } };
    if (status) filter.refundStatus = status.toUpperCase();

    const orders = await Order.find(filter)
      .sort({ updatedAt: -1 })
      .populate("sellerId", "name email")
      .select("orderNumber sellerId buyer.name status total subtotal refundStatus refundEligibleAmount walletRefundedAmount refundApprovedAt refundApprovedBy refundRejectedReason updatedAt")
      .lean();

    res.json({ success: true, orders, count: orders.length });
  } catch (err) {
    console.error("[refunds]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/admin/refunds/:id/approve ──────────────────────
// Credits the seller wallet with the product-cost-only refund
router.patch("/:id/approve", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findById(req.params.id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (order.refundStatus !== "PENDING") {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `No pending refund on this order (current refund status: ${order.refundStatus})`,
      });
    }

    let wallet = await Wallet.findOne({ sellerId: order.sellerId }).session(session);
    if (!wallet) wallet = (await Wallet.create([{ sellerId: order.sellerId }], { session }))[0];

    const amount = order.refundEligibleAmount;
    const balanceBefore = wallet.balance;
    const balanceAfter  = balanceBefore + amount;

    await Wallet.findByIdAndUpdate(
      wallet._id,
      { $inc: { balance: amount, totalCredited: amount } },
      { session }
    );

    await Transaction.create([{
      walletId:      wallet._id,
      sellerId:      order.sellerId,
      type:          "CREDIT",
      amount,
      balanceBefore,
      balanceAfter,
      description:   `Product-cost refund approved for order ${order.orderNumber}`,
      reference:     `ORDER-${order.orderNumber}-REFUND`,
      category:      "REFUND",
      status:        "COMPLETED",
      metadata:      { orderId: order._id },
    }], { session });

    order.refundStatus         = "APPROVED";
    order.refundApprovedAt     = new Date();
    order.refundApprovedBy     = req.seller?.name || "Admin";
    order.walletRefunded       = true;
    order.walletRefundedAmount = amount;
    order.statusHistory.push({
      status:    order.status,
      note:      `Refund of ₹${amount.toLocaleString("en-IN")} (product cost) approved and credited to seller wallet`,
      changedAt: new Date(),
    });

    await order.save({ session });
    await session.commitTransaction();

    await logAction(req, {
      action:      "OTHER",
      entity:      "Order",
      entityId:    order._id,
      entityRef:   order.orderNumber,
      description: `Refund approved for ${order.orderNumber}: ₹${amount.toLocaleString("en-IN")} credited to seller wallet`,
    });

    res.json({
      success: true,
      message: `₹${amount.toLocaleString("en-IN")} credited to seller wallet`,
      order,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error("[refunds/approve]", err);
    res.status(500).json({ success: false, message: "Server error" });
  } finally {
    session.endSession();
  }
});

// ── PATCH /api/admin/refunds/:id/reject ───────────────────────
// Declines the refund — no wallet change
router.patch("/:id/reject", async (req, res) => {
  try {
    const { reason } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    if (order.refundStatus !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: `No pending refund on this order (current refund status: ${order.refundStatus})`,
      });
    }

    order.refundStatus         = "REJECTED";
    order.refundRejectedReason = reason || "Rejected by admin";
    order.statusHistory.push({
      status:    order.status,
      note:      `Refund rejected: ${reason || "No reason given"}`,
      changedAt: new Date(),
    });
    await order.save();

    await logAction(req, {
      action:      "OTHER",
      entity:      "Order",
      entityId:    order._id,
      entityRef:   order.orderNumber,
      description: `Refund rejected for ${order.orderNumber}: ${reason || "No reason given"}`,
    });

    res.json({ success: true, message: "Refund rejected", order });
  } catch (err) {
    console.error("[refunds/reject]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
