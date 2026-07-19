const mongoose = require("mongoose");
const Wallet = require("../models/Wallet.model");
const Transaction = require("../models/Transaction.model");
const Seller = require("../models/Seller.model");

// ─────────────────────────────────────────────────────────────────────────────
// Seller.walletBalance is now the SINGLE SOURCE OF TRUTH for what a seller's
// wallet balance actually is. Every read (getBalance, getSummary) comes from
// there, and every write (credit, debit, order-confirmation debits, Razorpay
// top-up credits) updates it directly.
//
// The Wallet collection is kept only because Transaction documents have a
// required walletId foreign key — getOrCreateWallet still ensures one exists
// so transaction history keeps working, and its own .balance field is kept
// in sync as a mirror for backward compatibility with anything else that
// might still read it, but it is NOT what getBalance/getSummary return.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Helper: get or create seller wallet (for Transaction.walletId linkage only) ──
const getOrCreateWallet = async (sellerId, session) => {
  let wallet = await Wallet.findOne({ sellerId }).session(session || null);
  if (!wallet) {
    const created = await Wallet.create([{ sellerId }], session ? { session } : undefined);
    wallet = Array.isArray(created) ? created[0] : created;
  }
  return wallet;
};

// ─── GET /api/wallet/balance ────────────────────────────────────────────────────
// SELLER-SIDE — reads Seller.walletBalance directly.
exports.getBalance = async (req, res) => {
  try {
    const seller = await Seller.findById(req.seller.id).select("walletBalance").lean();
    const balance = seller?.walletBalance ?? 0;

    // totalCredited/totalDebited aren't stored fields on Seller — computed
    // live from the Transaction ledger so they stay accurate without
    // needing a schema change.
    const totals = await Transaction.aggregate([
      { $match: { sellerId: new mongoose.Types.ObjectId(req.seller.id), walletOwnerType: "SELLER", status: "COMPLETED" } },
      { $group: { _id: "$type", total: { $sum: "$amount" } } },
    ]);
    const totalCredited = totals.find(t => t._id === "CREDIT")?.total || 0;
    const totalDebited = totals.find(t => t._id === "DEBIT")?.total || 0;

    const recentTransactions = await Transaction.find({
      sellerId: req.seller.id,
      walletOwnerType: "SELLER",
    })
      .sort({ createdAt: -1 })
      .limit(5);

    res.status(200).json({
      success: true,
      // Also send balance at top level — several existing frontend pages
      // read res.data.balance directly rather than res.data.wallet.balance.
      balance,
      wallet: {
        balance,
        currency: "INR",
        totalCredited,
        totalDebited,
        isActive: true,
      },
      recentTransactions,
    });
  } catch (error) {
    console.error("Get balance error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── GET /api/wallet/transactions ───────────────────────────────────────────────
// SELLER-SIDE — unchanged, Transaction history is unaffected by this change.
exports.getTransactions = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const { type, category } = req.query;

    const filter = { sellerId: req.seller.id, walletOwnerType: "SELLER" };
    if (type) filter.type = type.toUpperCase();
    if (category) filter.category = category.toUpperCase();

    const [transactions, total] = await Promise.all([
      Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Transaction.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    });
  } catch (error) {
    console.error("Get transactions error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── POST /api/wallet/credit ────────────────────────────────────────────────────
// SELLER-SIDE (e.g. manual top-up via this endpoint, if used directly)
exports.credit = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { amount, description, reference, category } = req.body;

    if (!amount || amount <= 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Amount must be greater than 0" });
    }
    if (!description) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Description is required" });
    }

    const wallet = await getOrCreateWallet(req.seller.id, session);

    const sellerBefore = await Seller.findById(req.seller.id).select("walletBalance").session(session);
    const balanceBefore = sellerBefore?.walletBalance ?? 0;
    const balanceAfter = balanceBefore + Number(amount);

    // Seller.walletBalance is authoritative.
    await Seller.findByIdAndUpdate(
      req.seller.id,
      { $inc: { walletBalance: Number(amount) } },
      { session }
    );
    // Mirror onto the Wallet doc too, purely so anything still reading
    // Wallet.balance elsewhere doesn't see stale data.
    await Wallet.findByIdAndUpdate(
      wallet._id,
      { $inc: { balance: Number(amount), totalCredited: Number(amount) } },
      { session }
    );

    const transaction = await Transaction.create(
      [
        {
          walletOwnerType: "SELLER",
          walletId: wallet._id,
          sellerId: req.seller.id,
          type: "CREDIT",
          amount: Number(amount),
          balanceBefore,
          balanceAfter,
          description,
          reference: reference || `CR-${Date.now()}`,
          category: category || "TOPUP",
          status: "COMPLETED",
        },
      ],
      { session }
    );

    await session.commitTransaction();

    res.status(200).json({
      success: true,
      message: `₹${amount} credited successfully`,
      transaction: transaction[0],
      newBalance: balanceAfter,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Credit error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  } finally {
    session.endSession();
  }
};

// ─── POST /api/wallet/debit ──────────────────────────────────────────────────────
// SELLER-SIDE
exports.debit = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { amount, description, reference, category } = req.body;

    if (!amount || amount <= 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Amount must be greater than 0" });
    }
    if (!description) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Description is required" });
    }

    const wallet = await getOrCreateWallet(req.seller.id, session);

    const sellerBefore = await Seller.findById(req.seller.id).select("walletBalance").session(session);
    const balanceBefore = sellerBefore?.walletBalance ?? 0;

    if (balanceBefore < Number(amount)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available: ₹${balanceBefore}`,
        availableBalance: balanceBefore,
      });
    }

    const balanceAfter = balanceBefore - Number(amount);

    await Seller.findByIdAndUpdate(
      req.seller.id,
      { $inc: { walletBalance: -Number(amount) } },
      { session }
    );
    await Wallet.findByIdAndUpdate(
      wallet._id,
      { $inc: { balance: -Number(amount), totalDebited: Number(amount) } },
      { session }
    );

    const transaction = await Transaction.create(
      [
        {
          walletOwnerType: "SELLER",
          walletId: wallet._id,
          sellerId: req.seller.id,
          type: "DEBIT",
          amount: Number(amount),
          balanceBefore,
          balanceAfter,
          description,
          reference: reference || `DR-${Date.now()}`,
          category: category || "OTHER",
          status: "COMPLETED",
        },
      ],
      { session }
    );

    await session.commitTransaction();

    res.status(200).json({
      success: true,
      message: `₹${amount} debited successfully`,
      transaction: transaction[0],
      newBalance: balanceAfter,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Debit error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  } finally {
    session.endSession();
  }
};

// ─── GET /api/wallet/summary ──────────────────────────────────────────────────────
// SELLER-SIDE
exports.getSummary = async (req, res) => {
  try {
    const seller = await Seller.findById(req.seller.id).select("walletBalance").lean();
    const balance = seller?.walletBalance ?? 0;

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [allTimeStats, monthlyStats] = await Promise.all([
      Transaction.aggregate([
        { $match: { sellerId: new mongoose.Types.ObjectId(req.seller.id), walletOwnerType: "SELLER", status: "COMPLETED" } },
        { $group: { _id: "$type", total: { $sum: "$amount" } } },
      ]),
      Transaction.aggregate([
        {
          $match: {
            sellerId: new mongoose.Types.ObjectId(req.seller.id),
            walletOwnerType: "SELLER",
            createdAt: { $gte: startOfMonth },
            status: "COMPLETED",
          },
        },
        { $group: { _id: "$type", total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
    ]);

    const totalCredited = allTimeStats.find((s) => s._id === "CREDIT")?.total || 0;
    const totalDebited = allTimeStats.find((s) => s._id === "DEBIT")?.total || 0;
    const monthlyCredited = monthlyStats.find((s) => s._id === "CREDIT")?.total || 0;
    const monthlyDebited = monthlyStats.find((s) => s._id === "DEBIT")?.total || 0;

    res.status(200).json({
      success: true,
      summary: {
        currentBalance: balance,
        totalCredited,
        totalDebited,
        thisMonth: {
          credited: monthlyCredited,
          debited: monthlyDebited,
          net: monthlyCredited - monthlyDebited,
        },
      },
    });
  } catch (error) {
    console.error("Summary error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// CLIENT WALLET — legacy, from before Customers were split out of Seller.
// Left unchanged/unused here; flagged separately for cleanup.
// ══════════════════════════════════════════════════════════════════════════════

exports.getClientWallet = async (req, res) => {
  try {
    const { clientId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const client = await Seller.findById(clientId).select("name walletBalance totalRefunded");
    if (!client) {
      return res.status(404).json({ success: false, message: "Seller not found" });
    }

    const filter = { clientId, walletOwnerType: "CLIENT" };

    const [transactions, total] = await Promise.all([
      Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Transaction.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      wallet: {
        balance: client.walletBalance,
        totalRefunded: client.totalRefunded,
        clientName: client.name,
      },
      transactions,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("Get client wallet error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getRefundTransactionByOrder = async (req, res) => {
  try {
    const { orderId } = req.params;

    const transaction = await Transaction.findOne({
      "metadata.orderId": orderId,
      category: "REFUND",
      walletOwnerType: "CLIENT",
    }).populate("clientId", "name phone");

    if (!transaction) {
      return res.status(404).json({ success: false, message: "No refund transaction found for this order" });
    }

    res.status(200).json({ success: true, transaction });
  } catch (error) {
    console.error("Get refund transaction error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
