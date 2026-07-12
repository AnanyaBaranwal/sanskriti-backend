const mongoose = require("mongoose");
const PayoutRequest = require("../models/PayoutRequest.model");
const Wallet = require("../models/Wallet.model");
const Transaction = require("../models/Transaction.model");
//const Seller = require("../models/Seller.model");
const Seller = require("../models/Seller.model");
const Order = require("../models/Order.model");

// ─── POST /api/payouts/request ─────────────────────────────────────────────────
// SELLER-SIDE: request a bank payout from wallet balance
exports.requestPayout = async (req, res) => {
  try {
    const { amount, accountNumber, ifscCode, accountName, bankName, sellerNote } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Minimum payout amount is ₹100",
      });
    }

    if (!accountNumber || !ifscCode || !accountName) {
      return res.status(400).json({
        success: false,
        message: "Bank account number, IFSC code and account name are required",
      });
    }

    const wallet = await Wallet.findOne({ sellerId: req.seller.id });

    if (!wallet || wallet.balance < amount) {
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Available: ₹${wallet?.balance || 0}`,
        availableBalance: wallet?.balance || 0,
      });
    }

    const pendingPayout = await PayoutRequest.findOne({
      sellerId: req.seller.id,
      type: "SELLER_PAYOUT",
      status: "PENDING",
    });

    if (pendingPayout) {
      return res.status(400).json({
        success: false,
        message: "You already have a pending payout request. Wait for it to be processed.",
        existingRequest: pendingPayout._id,
      });
    }

    const payoutRequest = await PayoutRequest.create({
      type: "SELLER_PAYOUT",
      sellerId: req.seller.id,
      amount,
      bankDetails: {
        accountNumber,
        ifscCode: ifscCode.toUpperCase(),
        accountName,
        bankName: bankName || "",
      },
      sellerNote: sellerNote || "",
    });

    res.status(201).json({
      success: true,
      message: "Payout request submitted successfully. Admin will process it within 2-3 business days.",
      payoutRequest,
    });
  } catch (error) {
    console.error("Request payout error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── GET /api/payouts/my ───────────────────────────────────────────────────────
exports.getMyPayouts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const { status } = req.query;

    const filter = { sellerId: req.seller.id, type: "SELLER_PAYOUT" };
    if (status) filter.status = status.toUpperCase();

    const [payouts, total] = await Promise.all([
      PayoutRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      PayoutRequest.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      payouts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("Get payouts error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── GET /api/payouts/:id ──────────────────────────────────────────────────────
exports.getPayoutById = async (req, res) => {
  try {
    const payout = await PayoutRequest.findOne({
      _id: req.params.id,
      sellerId: req.seller.id, // ensure seller can only see their own
    });

    if (!payout) {
      return res.status(404).json({ success: false, message: "Payout request not found" });
    }

    res.status(200).json({ success: true, payout });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── DELETE /api/payouts/:id/cancel ────────────────────────────────────────────
exports.cancelPayout = async (req, res) => {
  try {
    const payout = await PayoutRequest.findOne({
      _id: req.params.id,
      sellerId: req.seller.id,
    });

    if (!payout) {
      return res.status(404).json({ success: false, message: "Payout request not found" });
    }

    if (payout.status !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel a payout that is already ${payout.status}`,
      });
    }

    await PayoutRequest.findByIdAndDelete(payout._id);

    res.status(200).json({ success: true, message: "Payout request cancelled successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── ADMIN: GET /api/payouts/admin/all ─────────────────────────────────────────
// Supports ?status=PENDING and ?type=SELLER_PAYOUT|CLIENT_REFUND
exports.adminGetAllPayouts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const { status, type } = req.query;

    const filter = {};
    if (status) filter.status = status.toUpperCase();
    if (type) filter.type = type.toUpperCase();

    const [payouts, total] = await Promise.all([
      PayoutRequest.find(filter)
        .populate("sellerId", "name email phone businessName")
        .populate("clientId", "name phone")
        .populate("orderId", "orderNumber")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      PayoutRequest.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      payouts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── ADMIN: PATCH /api/payouts/admin/:id/approve ───────────────────────────────
// Branches by payout.type:
//   CLIENT_REFUND  -> credits the client's wallet (Seller.walletBalance)
//   SELLER_PAYOUT  -> debits the seller's wallet (existing bank-payout flow)
exports.adminApprovePayout = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { adminNote } = req.body;

    const payout = await PayoutRequest.findById(req.params.id).session(session);

    if (!payout) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: "Payout not found" });
    }

    if (payout.status !== "PENDING") {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `Payout is already ${payout.status}`,
      });
    }

    // ══════════════════════════════════════════════════════════════════
    // BRANCH 1 — CLIENT_REFUND: credit client wallet, no bank transfer
    // ══════════════════════════════════════════════════════════════════
    if (payout.type === "CLIENT_REFUND") {
      const client = await Seller.findById(payout.clientId).session(session);
      if (!client) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: "Seller not found" });
      }

      const balanceBefore = client.walletBalance;
      const balanceAfter = balanceBefore + payout.amount;

      await Seller.findByIdAndUpdate(
        payout.clientId,
        { $inc: { walletBalance: payout.amount, totalRefunded: payout.amount } },
        { session }
      );

      const transaction = await Transaction.create(
        [
          {
            walletOwnerType: "CLIENT",
            clientId: payout.clientId,
            type: "CREDIT",
            amount: payout.amount,
            balanceBefore,
            balanceAfter,
            description: `Refund credited — order ${payout.orderId}`,
            reference: `REFUND-${payout._id}`,
            category: "REFUND",
            status: "COMPLETED",
            metadata: {
              orderId: payout.orderId,
              payoutRequestId: payout._id,
              returnId: payout.returnId,
            },
          },
        ],
        { session }
      );

      if (payout.orderId) {
        await Order.findByIdAndUpdate(
          payout.orderId,
          { paymentStatus: "REFUNDED", refundAmount: payout.amount },
          { session }
        );
      }

      await PayoutRequest.findByIdAndUpdate(
        payout._id,
        {
          status: "PROCESSED",
          adminNote: adminNote || "Refund credited to client wallet",
          processedAt: new Date(),
          transactionId: transaction[0]._id,
        },
        { session }
      );

      await session.commitTransaction();
      return res.status(200).json({
        success: true,
        message: `₹${payout.amount} credited to client's wallet`,
        newClientBalance: balanceAfter,
      });
    }

    // ══════════════════════════════════════════════════════════════════
    // BRANCH 2 — SELLER_PAYOUT: existing bank-payout flow (debit seller wallet)
    // ══════════════════════════════════════════════════════════════════
    const wallet = await Wallet.findOne({ sellerId: payout.sellerId }).session(session);

    if (!wallet || wallet.balance < payout.amount) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: "Seller has insufficient balance for this payout",
      });
    }

    const balanceBefore = wallet.balance;
    const balanceAfter = balanceBefore - payout.amount;

    await Wallet.findByIdAndUpdate(
      wallet._id,
      { $inc: { balance: -payout.amount, totalDebited: payout.amount } },
      { session }
    );

    const transaction = await Transaction.create(
      [
        {
          walletOwnerType: "SELLER",
          walletId: wallet._id,
          sellerId: payout.sellerId,
          type: "DEBIT",
          amount: payout.amount,
          balanceBefore,
          balanceAfter,
          description: `Payout processed to ${payout.bankDetails.accountName}`,
          reference: `PAYOUT-${payout._id}`,
          category: "PAYOUT",
          status: "COMPLETED",
          metadata: { payoutRequestId: payout._id },
        },
      ],
      { session }
    );

    await PayoutRequest.findByIdAndUpdate(
      payout._id,
      {
        status: "PROCESSED",
        adminNote: adminNote || "Approved and processed",
        processedAt: new Date(),
        transactionId: transaction[0]._id,
      },
      { session }
    );

    await session.commitTransaction();

    res.status(200).json({
      success: true,
      message: `Payout of ₹${payout.amount} processed successfully`,
      newSellerBalance: balanceAfter,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Approve payout error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  } finally {
    session.endSession();
  }
};

// ─── ADMIN: PATCH /api/payouts/admin/:id/reject ────────────────────────────────
// Works identically for both SELLER_PAYOUT and CLIENT_REFUND — no money moves.
exports.adminRejectPayout = async (req, res) => {
  try {
    const { adminNote } = req.body;

    if (!adminNote) {
      return res.status(400).json({
        success: false,
        message: "Admin note is required when rejecting a payout",
      });
    }

    const payout = await PayoutRequest.findById(req.params.id);

    if (!payout) {
      return res.status(404).json({ success: false, message: "Payout not found" });
    }

    if (payout.status !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: `Payout is already ${payout.status}`,
      });
    }

    await PayoutRequest.findByIdAndUpdate(payout._id, {
      status: "REJECTED",
      adminNote,
      rejectedAt: new Date(),
    });

    res.status(200).json({ success: true, message: "Payout request rejected" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};
