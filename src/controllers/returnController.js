const mongoose = require("mongoose");
const Return = require("../models/Return.model");
const Order = require("../models/Order.model");
const PayoutRequest = require("../models/PayoutRequest.model");

// ─── Helper: prorate discount onto a single item ──────────────────────────────
// productAmount = what the client actually paid for this item, post-discount,
// excluding tax and shipping entirely (tax is flat/order-level, never refunded).
function calculateDiscountedItemAmount(order, item) {
  if (!order.discountAmount || order.subtotal === 0) {
    return item.total;
  }
  const itemShareOfDiscount = (item.total / order.subtotal) * order.discountAmount;
  const discounted = item.total - itemShareOfDiscount;
  return Math.round(discounted * 100) / 100;
}

// ─── POST /api/returns ────────────────────────────────────────────────────────
// Create a return request for a specific item in an order
exports.createReturn = async (req, res) => {
  try {
    const { orderId, itemName, reason } = req.body;

    if (!orderId || !itemName) {
      return res.status(400).json({ success: false, message: "orderId and itemName are required" });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (!order.clientId) {
      return res.status(400).json({ success: false, message: "Order has no linked client — cannot create return" });
    }

    const item = order.items.find((i) => i.name === itemName);
    if (!item) {
      return res.status(404).json({ success: false, message: "Item not found in this order" });
    }

    // Prevent duplicate open return requests for the same item on the same order
    const existing = await Return.findOne({
      orderId: order._id,
      itemName: item.name,
      status: { $in: ["PENDING", "RECEIVED", "APPROVED"] },
    });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: "An active return request already exists for this item",
        existingReturn: existing._id,
      });
    }

    const productAmount = calculateDiscountedItemAmount(order, item);

    const returnReq = await Return.create({
      orderId: order._id,
      clientId: order.clientId,
      sellerId: order.sellerId,
      itemName: item.name,
      itemPrice: item.price,
      quantity: item.quantity,
      productAmount,
      refundAmount: productAmount, // pre-filled default, admin can lower it later
      reason: reason || "",
      status: "PENDING",
    });

    res.status(201).json({ success: true, returnRequest: returnReq });
  } catch (error) {
    console.error("Create return error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── GET /api/returns (admin) ──────────────────────────────────────────────────
exports.getAllReturns = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const { status, search } = req.query;

    const filter = {};
    if (status) filter.status = status.toUpperCase();

    let query = Return.find(filter)
      .populate("clientId", "name phone")
      .populate("orderId", "orderNumber")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const [returns, total] = await Promise.all([query, Return.countDocuments(filter)]);

    // Optional client-side-style search filter on populated fields
    let filtered = returns;
    if (search) {
      const s = search.toLowerCase();
      filtered = returns.filter(
        (r) =>
          r.itemName?.toLowerCase().includes(s) ||
          r.clientId?.name?.toLowerCase().includes(s) ||
          r.orderId?.orderNumber?.toLowerCase().includes(s)
      );
    }

    res.status(200).json({
      success: true,
      returns: filtered,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("Get returns error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── GET /api/returns/:id ───────────────────────────────────────────────────────
exports.getReturnById = async (req, res) => {
  try {
    const returnReq = await Return.findById(req.params.id)
      .populate("clientId", "name phone email")
      .populate("orderId", "orderNumber total");
    if (!returnReq) {
      return res.status(404).json({ success: false, message: "Return not found" });
    }
    res.status(200).json({ success: true, returnRequest: returnReq });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── PATCH /api/returns/:id/mark-received ──────────────────────────────────────
exports.markReceived = async (req, res) => {
  try {
    const { notes } = req.body;
    const returnReq = await Return.findById(req.params.id);
    if (!returnReq) {
      return res.status(404).json({ success: false, message: "Return not found" });
    }
    if (returnReq.status !== "PENDING") {
      return res.status(400).json({ success: false, message: `Cannot mark received — status is ${returnReq.status}` });
    }

    returnReq.status = "RECEIVED";
    returnReq.receivedAt = new Date();
    if (notes) returnReq.notes = notes;
    await returnReq.save();

    res.status(200).json({ success: true, returnRequest: returnReq });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── PATCH /api/returns/:id/approve ────────────────────────────────────────────
// Approving does NOT move money. It creates a PENDING CLIENT_REFUND PayoutRequest.
// Money only moves when admin approves that payout on the Payouts page.
exports.approveReturn = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { refundAmount, adminNote } = req.body;

    const returnReq = await Return.findById(req.params.id).session(session);
    if (!returnReq) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: "Return not found" });
    }
    if (returnReq.status !== "RECEIVED") {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Item must be marked received before approval" });
    }

    const requestedAmount = Number(refundAmount);
    if (!requestedAmount || requestedAmount <= 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "refundAmount must be greater than 0" });
    }
    if (requestedAmount > returnReq.productAmount) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `Refund cannot exceed ₹${returnReq.productAmount} (actual amount paid for this item)`,
      });
    }

    const order = await Order.findById(returnReq.orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: "Linked order not found" });
    }

    // 1. Create the refund request — lands in the Payouts queue
    const payoutRequest = await PayoutRequest.create(
      [
        {
          type: "CLIENT_REFUND",
          clientId: returnReq.clientId,
          orderId: order._id,
          returnId: returnReq._id,
          amount: requestedAmount,
          sellerNote: `Refund for returned item "${returnReq.itemName}" — order ${order.orderNumber}`,
          status: "PENDING",
        },
      ],
      { session }
    );

    // 2. Mark return approved and link the payout request
    returnReq.status = "APPROVED";
    returnReq.refundAmount = requestedAmount;
    returnReq.payoutRequestId = payoutRequest[0]._id;
    if (adminNote) returnReq.notes = adminNote;
    await returnReq.save({ session });

    await session.commitTransaction();
    res.status(200).json({
      success: true,
      message: "Return approved. Refund request sent to Payouts for processing.",
      returnRequest: returnReq,
      payoutRequest: payoutRequest[0],
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Approve return error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  } finally {
    session.endSession();
  }
};

// ─── PATCH /api/returns/:id/reject ─────────────────────────────────────────────
exports.rejectReturn = async (req, res) => {
  try {
    const { notes } = req.body;
    if (!notes) {
      return res.status(400).json({ success: false, message: "A note is required when rejecting a return" });
    }
    const returnReq = await Return.findById(req.params.id);
    if (!returnReq) {
      return res.status(404).json({ success: false, message: "Return not found" });
    }
    returnReq.status = "REJECTED";
    returnReq.notes = notes;
    returnReq.resolvedAt = new Date();
    await returnReq.save();

    res.status(200).json({ success: true, returnRequest: returnReq });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── PATCH /api/returns/:id/dispute ────────────────────────────────────────────
exports.disputeReturn = async (req, res) => {
  try {
    const { disputeNote } = req.body;
    const returnReq = await Return.findById(req.params.id);
    if (!returnReq) {
      return res.status(404).json({ success: false, message: "Return not found" });
    }
    returnReq.status = "DISPUTED";
    returnReq.disputeNote = disputeNote || "";
    await returnReq.save();

    res.status(200).json({ success: true, returnRequest: returnReq });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};
