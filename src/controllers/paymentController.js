const crypto = require("crypto");
const Razorpay = require("razorpay");
const Wallet = require("../models/Wallet.model");
const Transaction = require("../models/Transaction.model");
const Seller = require("../models/Seller.model");
const mongoose = require("mongoose");
const { checkSellerEligibility, eligibilityMessage } = require("../utils/sellerEligibility");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─── POST /api/payments/create-order ─────────────────────────────────────────
exports.createOrder = async (req, res) => {
  try {
    // Gate BEFORE the Razorpay checkout even opens — deliberately not
    // enforced in /verify or the webhook below, since by that point the
    // seller has already paid and must be credited regardless.
    const eligibility = await checkSellerEligibility(req.seller.id);
    if (!eligibility.eligible) {
      return res.status(403).json({
        success: false,
        message: eligibilityMessage(eligibility),
        eligibility,
      });
    }

    const { amount } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({ success: false, message: "Minimum top-up amount is ₹1" });
    }
    if (amount > 100000) {
      return res.status(400).json({ success: false, message: "Maximum top-up amount is ₹1,00,000" });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // paise
      currency: "INR",
      // Razorpay's receipt field has a hard 40-character limit — keep this short
      receipt: `wtu_${req.seller.id.toString().slice(-8)}_${Date.now()}`,
      notes: { sellerId: String(req.seller.id) }, // webhook uses this to find the wallet
    });

    res.status(200).json({
      success: true,
      order: { id: order.id, amount: order.amount, currency: order.currency, receipt: order.receipt },
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Create order error:", error);
    res.status(500).json({ success: false, message: "Failed to create payment order" });
  }
};

// ─── POST /api/payments/verify ────────────────────────────────────────────────
// Seller.walletBalance is the authoritative wallet balance (see
// walletController.js) — this credits it directly, in the same transaction
// as the Wallet-collection mirror update, so the two never drift apart.
//
// NOTE: deliberately NOT gated by checkSellerEligibility. If a seller was
// eligible when create-order ran but somehow becomes ineligible before
// verify (e.g. admin revokes KYC mid-checkout), the payment has already
// been taken by Razorpay — blocking the credit here would take their
// money without crediting their wallet. Eligibility is enforced only at
// the point of *initiating* a new charge, never at the point of
// confirming money already collected.
exports.verifyPayment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !amount) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Missing payment verification fields" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Payment verification failed. Invalid signature." });
    }

    const existing = await Transaction.findOne({ reference: razorpay_order_id });
    if (existing) {
      await session.abortTransaction();
      return res.status(200).json({ success: true, message: "Payment already processed", alreadyProcessed: true });
    }

    let wallet = await Wallet.findOne({ sellerId: req.seller.id }).session(session);
    if (!wallet) {
      const created = await Wallet.create([{ sellerId: req.seller.id }], { session });
      wallet = created[0];
    }

    const amountInRupees = Number(amount) / 100;

    const sellerBefore = await Seller.findById(req.seller.id).select("walletBalance").session(session);
    const balanceBefore = sellerBefore?.walletBalance ?? 0;
    const balanceAfter = balanceBefore + amountInRupees;

    // Authoritative balance update.
    await Seller.findByIdAndUpdate(
      req.seller.id,
      { $inc: { walletBalance: amountInRupees } },
      { session }
    );
    // Mirror onto the Wallet doc so nothing else reading Wallet.balance is stale.
    await Wallet.findByIdAndUpdate(
      wallet._id,
      { $inc: { balance: amountInRupees, totalCredited: amountInRupees } },
      { session }
    );

    await Transaction.create(
      [{
        walletId: wallet._id,
        walletOwnerType: "SELLER",
        sellerId: req.seller.id,
        type: "CREDIT",
        amount: amountInRupees,
        balanceBefore,
        balanceAfter,
        description: "Wallet top-up via Razorpay",
        reference: razorpay_order_id,
        category: "TOPUP",
        status: "COMPLETED",
        metadata: { razorpay_order_id, razorpay_payment_id },
      }],
      { session }
    );

    await session.commitTransaction();

    res.status(200).json({
      success: true,
      message: `₹${amountInRupees} added to your wallet successfully!`,
      newBalance: balanceAfter,
      paymentId: razorpay_payment_id,
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
// Called directly by Razorpay's servers. Confirms payment even if the seller
// closed the browser before the frontend could call /verify. Same rule as
// /verify above: never gated by eligibility — money has already changed hands.
exports.webhook = async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.body) // raw Buffer — must match exactly what Razorpay signed
      .digest("hex");

    if (signature !== expectedSignature) {
      console.error("Webhook signature mismatch");
      return res.status(400).json({ success: false, message: "Invalid signature" });
    }

    const payload = JSON.parse(req.body.toString());

    if (payload.event !== "payment.captured") {
      return res.status(200).json({ success: true, message: "Event ignored" });
    }

    const payment = payload.payload.payment.entity;
    const razorpay_order_id = payment.order_id;
    const razorpay_payment_id = payment.id;
    const amountInRupees = payment.amount / 100;
    const sellerId = payment.notes?.sellerId;

    if (!sellerId) {
      console.error("Webhook: no sellerId in notes for order", razorpay_order_id);
      return res.status(200).json({ success: true, message: "No sellerId — ignored" });
    }

    const existing = await Transaction.findOne({ reference: razorpay_order_id });
    if (existing) {
      return res.status(200).json({ success: true, message: "Already processed" });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      let wallet = await Wallet.findOne({ sellerId }).session(session);
      if (!wallet) {
        const created = await Wallet.create([{ sellerId }], { session });
        wallet = created[0];
      }

      const sellerBefore = await Seller.findById(sellerId).select("walletBalance").session(session);
      const balanceBefore = sellerBefore?.walletBalance ?? 0;
      const balanceAfter = balanceBefore + amountInRupees;

      await Seller.findByIdAndUpdate(
        sellerId,
        { $inc: { walletBalance: amountInRupees } },
        { session }
      );
      await Wallet.findByIdAndUpdate(
        wallet._id,
        { $inc: { balance: amountInRupees, totalCredited: amountInRupees } },
        { session }
      );

      await Transaction.create(
        [{
          walletId: wallet._id,
          walletOwnerType: "SELLER",
          sellerId,
          type: "CREDIT",
          amount: amountInRupees,
          balanceBefore,
          balanceAfter,
          description: "Wallet top-up via Razorpay (webhook)",
          reference: razorpay_order_id,
          category: "TOPUP",
          status: "COMPLETED",
          metadata: { razorpay_order_id, razorpay_payment_id, source: "webhook" },
        }],
        { session }
      );

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(200).json({ success: false, message: "Webhook processing error" });
  }
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
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};
