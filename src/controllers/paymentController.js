const crypto = require("crypto");
const Wallet = require("../models/Wallet.model");
const Transaction = require("../models/Transaction.model");
const mongoose = require("mongoose");

// ─── POST /api/payments/create-order ─────────────────────────────────────────
// Mock version — simulates Razorpay order creation
exports.createOrder = async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({
        success: false,
        message: "Minimum top-up amount is ₹1",
      });
    }

    if (amount > 100000) {
      return res.status(400).json({
        success: false,
        message: "Maximum top-up amount is ₹1,00,000",
      });
    }

    // Generate mock order ID (same format as Razorpay)
    const mockOrderId = `order_mock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    res.status(200).json({
      success: true,
      order: {
        id: mockOrderId,
        amount: amount * 100, // in paise
        currency: "INR",
        receipt: `wallet_topup_${req.seller.id}_${Date.now()}`,
      },
      key: process.env.RAZORPAY_KEY_ID || "mock_key",
      mock: true, // flag so frontend knows this is mock
    });
  } catch (error) {
    console.error("Create order error:", error);
    res.status(500).json({ success: false, message: "Failed to create payment order" });
  }
};

// ─── POST /api/payments/verify ────────────────────────────────────────────────
// Mock version — skips signature verification, directly credits wallet
exports.verifyPayment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { razorpay_order_id, amount } = req.body;

    if (!razorpay_order_id || !amount) {
      return res.status(400).json({
        success: false,
        message: "Missing order ID or amount",
      });
    }

    // Generate mock payment ID
    const mockPaymentId = `pay_mock_${Date.now()}`;

    // Check duplicate
    const existing = await Transaction.findOne({
      reference: razorpay_order_id,
    });

    if (existing) {
      await session.abortTransaction();
      return res.status(200).json({
        success: true,
        message: "Payment already processed",
        alreadyProcessed: true,
      });
    }

    // Get or create wallet
    let wallet = await Wallet.findOne({ sellerId: req.seller.id }).session(session);
    if (!wallet) {
      const created = await Wallet.create([{ sellerId: req.seller.id }], { session });
      wallet = created[0];
    }

    // Amount in rupees
    const amountInRupees = Number(amount) / 100;
    const balanceBefore = wallet.balance;
    const balanceAfter = balanceBefore + amountInRupees;

    // Credit wallet
    await Wallet.findByIdAndUpdate(
      wallet._id,
      {
        $inc: {
          balance: amountInRupees,
          totalCredited: amountInRupees,
        },
      },
      { session }
    );

    // Record transaction
    await Transaction.create(
      [
        {
          walletId: wallet._id,
          sellerId: req.seller.id,
          type: "CREDIT",
          amount: amountInRupees,
          balanceBefore,
          balanceAfter,
          description: `Wallet top-up (mock payment)`,
          reference: razorpay_order_id,
          category: "TOPUP",
          status: "COMPLETED",
          metadata: {
            razorpay_order_id,
            mock_payment_id: mockPaymentId,
            mock: true,
          },
        },
      ],
      { session }
    );

    await session.commitTransaction();

    res.status(200).json({
      success: true,
      message: `₹${amountInRupees} added to your wallet successfully!`,
      newBalance: balanceAfter,
      paymentId: mockPaymentId,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Verify payment error:", error);
    res.status(500).json({ success: false, message: "Payment verification failed" });
  } finally {
    session.endSession();
  }
};

// ─── POST /api/payments/webhook ───────────────────────────────────────────────
exports.webhook = async (req, res) => {
  // Mock webhook — just acknowledge
  console.log("Webhook received:", req.body?.event || "mock");
  res.status(200).json({ success: true });
};

// ─── GET /api/payments/history ────────────────────────────────────────────────
exports.getPaymentHistory = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const transactions = await Transaction.find({
      sellerId: req.seller.id,
      category: "TOPUP",
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Transaction.countDocuments({
      sellerId: req.seller.id,
      category: "TOPUP",
    });

    res.status(200).json({
      success: true,
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};