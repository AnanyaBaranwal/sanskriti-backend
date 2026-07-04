const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");

const Return      = require("../../models/Return.model");
const Order       = require("../../models/Order.model");
const Wallet       = require("../../models/Wallet.model");
const Transaction  = require("../../models/Transaction.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");
const { logAction } = require("../../utils/audit");

router.use(protect, restrictTo("admin"));

// ── Helper: compute refundable split from the live order ────────
// productAmount = pure product value (excl. GST). This is the hard
// refund ceiling everywhere below. gstAmount is shown for transparency
// but is never included in a payout.
function computeRefundSplit(order, itemName) {
  if (!itemName || itemName === "ALL") {
    return {
      orderAmount:   order.total,
      productAmount: order.subtotal,
      gstAmount:     order.taxAmount || 0,
    };
  }
  const item = order.items.find((i) => i.name === itemName);
  if (!item) {
    const err = new Error(`Item "${itemName}" was not found on order ${order.orderNumber}`);
    err.status = 400;
    throw err;
  }
  // item.total is already pre-tax (subtotal is just the sum of item totals),
  // so it IS the product amount for that item. GST is prorated by the
  // item's share of the order subtotal.
  const proportion    = order.subtotal > 0 ? item.total / order.subtotal : 0;
  const productAmount = Math.round(item.total);
  const gstAmount      = Math.round((order.taxAmount || 0) * proportion);
  return {
    orderAmount:   productAmount + gstAmount,
    productAmount,
    gstAmount,
  };
}

// ── GET /api/admin/returns ───────────────────────────────────────
// List + search + filter + aggregate counts for the stat cards
router.get("/", async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;

    const filter = {};
    if (status) filter.status = status.toUpperCase();
    if (search) {
      filter.$or = [
        { orderNumber:   { $regex: search, $options: "i" } },
        { "buyer.name":  { $regex: search, $options: "i" } },
        { "buyer.phone": { $regex: search, $options: "i" } },
        { itemName:      { $regex: search, $options: "i" } },
      ];
    }

    const [returns, total, statusCounts, refundedAgg, pendingAgg] = await Promise.all([
      Return.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit)).lean(),
      Return.countDocuments(filter),
      Return.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Return.aggregate([{ $match: { status: "REFUNDED" } }, { $group: { _id: null, total: { $sum: "$refundAmount" } } }]),
      Return.aggregate([{ $match: { status: "APPROVED" } }, { $group: { _id: null, total: { $sum: "$refundAmount" } } }]),
    ]);

    const countMap = statusCounts.reduce((acc, c) => { acc[c._id] = c.count; return acc; }, {});
    const allCount = await Return.countDocuments({});

    res.json({
      success: true,
      total,
      page: Number(page),
      pages: Math.ceil(total / limit) || 1,
      returns,
      counts: {
        all:      allCount,
        PENDING:  countMap.PENDING  || 0,
        RECEIVED: countMap.RECEIVED || 0,
        APPROVED: countMap.APPROVED || 0,
        REFUNDED: countMap.REFUNDED || 0,
        REJECTED: countMap.REJECTED || 0,
        DISPUTED: countMap.DISPUTED || 0,
      },
      totalRefundValue:   refundedAgg[0]?.total || 0,
      pendingRefundValue: pendingAgg[0]?.total   || 0,
    });
  } catch (err) {
    console.error("[returns:list]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /api/admin/returns ──────────────────────────────────────
// Create a return request against an existing order. itemName is
// optional — omit or pass "ALL" to return the whole order.
router.post("/", async (req, res) => {
  try {
    const { orderId, itemName, reason, images } = req.body;
    if (!orderId || !reason) {
      return res.status(400).json({ success: false, message: "orderId and reason are required" });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    if (!["DELIVERED", "SHIPPED"].includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: `Only DELIVERED or SHIPPED orders can be returned. Current status: ${order.status}`,
      });
    }

    const { orderAmount, productAmount, gstAmount } = computeRefundSplit(order, itemName);

    const ret = await Return.create({
      orderId:     order._id,
      orderNumber: order.orderNumber,
      sellerId:    order.sellerId,
      buyer: {
        name:  order.buyer?.name,
        email: order.buyer?.email || "",
        phone: order.buyer?.phone,
      },
      itemName: itemName || "ALL",
      orderAmount, productAmount, gstAmount,
      reason,
      images: images || [],
      statusHistory: [{ status: "PENDING", note: "Return requested", changedAt: new Date() }],
    });

    await logAction(req, {
      action: "CREATE",
      entity: "Return",
      entityId: ret._id,
      entityRef: order.orderNumber,
      description: `Return requested for order ${order.orderNumber} (${ret.itemName}) — refundable product amount ₹${productAmount}`,
    });

    res.status(201).json({ success: true, return: ret });
  } catch (err) {
    console.error("[returns:create]", err);
    res.status(err.status || 500).json({ success: false, message: err.message || "Server error" });
  }
});

// ── PATCH /api/admin/returns/:id/receive ─────────────────────────
router.patch("/:id/receive", async (req, res) => {
  try {
    const { notes } = req.body;
    const ret = await Return.findById(req.params.id);
    if (!ret) return res.status(404).json({ success: false, message: "Return not found" });
    if (ret.status !== "PENDING") {
      return res.status(400).json({ success: false, message: `Cannot mark received from status ${ret.status}` });
    }

    ret.status = "RECEIVED";
    ret.receivedAt = new Date();
    if (notes !== undefined) ret.notes = notes;
    ret.statusHistory.push({ status: "RECEIVED", note: notes || "Item received", changedAt: new Date() });
    await ret.save();

    await logAction(req, {
      action: "STATUS_CHANGE", entity: "Return", entityId: ret._id, entityRef: ret.orderNumber,
      description: `Return marked RECEIVED for ${ret.orderNumber}`,
      before: { status: "PENDING" }, after: { status: "RECEIVED" },
    });

    res.json({ success: true, return: ret });
  } catch (err) {
    console.error("[returns:receive]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/admin/returns/:id/approve ─────────────────────────
// THIS is where the GST-exclusion cap is enforced. Any refundAmount
// above productAmount is rejected outright with a 400 — never clamped
// silently, so the admin sees exactly why.
router.patch("/:id/approve", async (req, res) => {
  try {
    const { refundAmount, notes } = req.body;
    const ret = await Return.findById(req.params.id);
    if (!ret) return res.status(404).json({ success: false, message: "Return not found" });
    if (ret.status !== "RECEIVED") {
      return res.status(400).json({ success: false, message: `Cannot approve from status ${ret.status}` });
    }

    const amount = Number(refundAmount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: "A valid refund amount is required" });
    }
    if (amount > ret.productAmount) {
      return res.status(400).json({
        success: false,
        message: `Refund amount ₹${amount.toLocaleString("en-IN")} exceeds the refundable product amount ₹${ret.productAmount.toLocaleString("en-IN")}. GST (₹${ret.gstAmount.toLocaleString("en-IN")}), packaging & shipping are not refundable.`,
      });
    }

    ret.status = "APPROVED";
    ret.refundAmount = amount;
    if (notes !== undefined) ret.notes = notes;
    ret.statusHistory.push({ status: "APPROVED", note: `Refund approved: ₹${amount}`, changedAt: new Date() });
    await ret.save();

    await logAction(req, {
      action: "STATUS_CHANGE", entity: "Return", entityId: ret._id, entityRef: ret.orderNumber,
      description: `Return APPROVED for ${ret.orderNumber} — ₹${amount} (product-only, GST ₹${ret.gstAmount} excluded)`,
      before: { status: "RECEIVED" }, after: { status: "APPROVED", refundAmount: amount },
    });

    res.json({ success: true, return: ret });
  } catch (err) {
    console.error("[returns:approve]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/admin/returns/:id/reject ──────────────────────────
router.patch("/:id/reject", async (req, res) => {
  try {
    const { notes } = req.body;
    const ret = await Return.findById(req.params.id);
    if (!ret) return res.status(404).json({ success: false, message: "Return not found" });
    if (!["PENDING", "RECEIVED"].includes(ret.status)) {
      return res.status(400).json({ success: false, message: `Cannot reject from status ${ret.status}` });
    }

    ret.status = "REJECTED";
    ret.resolvedAt = new Date();
    if (notes !== undefined) ret.notes = notes;
    ret.statusHistory.push({ status: "REJECTED", note: notes || "Return rejected", changedAt: new Date() });
    await ret.save();

    await logAction(req, {
      action: "STATUS_CHANGE", entity: "Return", entityId: ret._id, entityRef: ret.orderNumber,
      description: `Return REJECTED for ${ret.orderNumber}`,
    });

    res.json({ success: true, return: ret });
  } catch (err) {
    console.error("[returns:reject]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/admin/returns/:id/dispute ─────────────────────────
router.patch("/:id/dispute", async (req, res) => {
  try {
    const { disputeNote } = req.body;
    const ret = await Return.findById(req.params.id);
    if (!ret) return res.status(404).json({ success: false, message: "Return not found" });
    if (!["PENDING", "RECEIVED"].includes(ret.status)) {
      return res.status(400).json({ success: false, message: `Cannot dispute from status ${ret.status}` });
    }

    ret.status = "DISPUTED";
    ret.disputeNote = disputeNote || ret.disputeNote;
    ret.statusHistory.push({ status: "DISPUTED", note: disputeNote || "Marked as disputed", changedAt: new Date() });
    await ret.save();

    await logAction(req, {
      action: "STATUS_CHANGE", entity: "Return", entityId: ret._id, entityRef: ret.orderNumber,
      description: `Return marked DISPUTED for ${ret.orderNumber}`,
    });

    res.json({ success: true, return: ret });
  } catch (err) {
    console.error("[returns:dispute]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/admin/returns/:id/notes ───────────────────────────
router.patch("/:id/notes", async (req, res) => {
  try {
    const { notes } = req.body;
    const ret = await Return.findByIdAndUpdate(req.params.id, { notes }, { new: true });
    if (!ret) return res.status(404).json({ success: false, message: "Return not found" });
    res.json({ success: true, return: ret });
  } catch (err) {
    console.error("[returns:notes]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/admin/returns/:id/refund ──────────────────────────
// Actually moves money. Re-validates the cap a SECOND time right
// before crediting the wallet — defense in depth, in case anything
// between approve and refund could have altered the record. Wraps
// the wallet credit + return update + order update in one Mongo
// transaction so partial failures can't leave inconsistent state.
router.patch("/:id/refund", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const ret = await Return.findById(req.params.id).session(session);
    if (!ret) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: "Return not found" });
    }
    if (ret.status !== "APPROVED") {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `Cannot process refund from status ${ret.status}` });
    }
    if (ret.refundAmount <= 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Refund amount must be greater than 0" });
    }
    if (ret.refundAmount > ret.productAmount) {
      // Should be impossible given the approve-step check, but never trust it blindly at payout time.
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Refund amount exceeds refundable product amount. Aborting for safety." });
    }

    let wallet = await Wallet.findOne({ sellerId: ret.sellerId }).session(session);
    if (!wallet) {
      const created = await Wallet.create([{ sellerId: ret.sellerId }], { session });
      wallet = created[0];
    }

    const balanceBefore = wallet.balance;
    const balanceAfter  = balanceBefore + ret.refundAmount;

    await Wallet.findByIdAndUpdate(
      wallet._id,
      { $inc: { balance: ret.refundAmount, totalCredited: ret.refundAmount } },
      { session }
    );

    await Transaction.create(
      [{
        walletId:    wallet._id,
        sellerId:    ret.sellerId,
        type:        "CREDIT",
        amount:      ret.refundAmount,
        balanceBefore,
        balanceAfter,
        description: `Refund processed — ${ret.orderNumber} (${ret.itemName}) — product amount only, GST excluded`,
        reference:   `REFUND-${ret._id}`,
        category:    "REFUND",
        status:      "COMPLETED",
        metadata:    { returnId: ret._id, orderId: ret.orderId, gstExcluded: ret.gstAmount },
      }],
      { session }
    );

    ret.status = "REFUNDED";
    ret.resolvedAt = new Date();
    ret.statusHistory.push({ status: "REFUNDED", note: `₹${ret.refundAmount} credited to seller wallet`, changedAt: new Date() });
    await ret.save({ session });

    await Order.findByIdAndUpdate(
      ret.orderId,
      {
        paymentStatus: "REFUNDED",
        refundAmount:  ret.refundAmount,
        returnReason:  ret.reason,
        returnedAt:    new Date(),
      },
      { session }
    );

    await session.commitTransaction();

    await logAction(req, {
      action: "STATUS_CHANGE", entity: "Return", entityId: ret._id, entityRef: ret.orderNumber,
      description: `Refund of ₹${ret.refundAmount} processed for ${ret.orderNumber} (GST ₹${ret.gstAmount} excluded, not refunded)`,
      before: { status: "APPROVED" }, after: { status: "REFUNDED", refundAmount: ret.refundAmount },
    });

    res.json({ success: true, message: `₹${ret.refundAmount} credited to seller wallet`, return: ret, newBalance: balanceAfter });
  } catch (err) {
    await session.abortTransaction();
    console.error("[returns:refund]", err);
    res.status(500).json({ success: false, message: "Server error" });
  } finally {
    session.endSession();
  }
});

module.exports = router;
