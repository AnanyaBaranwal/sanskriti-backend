const mongoose = require("mongoose");
const Wallet = require("../models/Wallet.model");
const Transaction = require("../models/Transaction.model");
const Client = require("../models/Client.model");

// ─── Helper: get or create seller wallet ───────────────────────────────────────
const getOrCreateWallet = async (sellerId) => {
  let wallet = await Wallet.findOne({ sellerId });
  if (!wallet) {
    wallet = await Wallet.create({ sellerId });
  }
  return wallet;
};

// ─── GET /api/wallet/balance ────────────────────────────────────────────────────
// SELLER-SIDE
exports.getBalance = async (req, res) => {
  try {
    const wallet = await getOrCreateWallet(req.seller.id);

    const recentTransactions = await Transaction.find({
      sellerId: req.seller.id,
      walletOwnerType: "SELLER",
    })
      .sort({ createdAt: -1 })
      .limit(5);

    res.status(200).json({
      success: true,
      wallet: {
        balance: wallet.balance,
        currency: wallet.currency,
        totalCredited: wallet.totalCredited,
        totalDebited: wallet.totalDebited,
        isActive: wallet.isActive,
      },
      recentTransactions,
    });
  } catch (error) {
    console.error("Get balance error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── GET /api/wallet/transactions ───────────────────────────────────────────────
// SELLER-SIDE
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
// SELLER-SIDE (e.g. top-up)
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

    let wallet = await Wallet.findOne({ sellerId: req.seller.id }).session(session);
    if (!wallet) {
      const created = await Wallet.create([{ sellerId: req.seller.id }], { session });
      wallet = created[0];
    }

    const balanceBefore = wallet.balance;
    const balanceAfter = balanceBefore + Number(amount);

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

    const wallet = await Wallet.findOne({ sellerId: req.seller.id }).session(session);
    if (!wallet) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: "Wallet not found" });
    }

    if (wallet.balance < Number(amount)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available: ₹${wallet.balance}`,
        availableBalance: wallet.balance,
      });
    }

    const balanceBefore = wallet.balance;
    const balanceAfter = balanceBefore - Number(amount);

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
    const wallet = await getOrCreateWallet(req.seller.id);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const monthlyStats = await Transaction.aggregate([
      {
        $match: {
          sellerId: new mongoose.Types.ObjectId(req.seller.id),
          walletOwnerType: "SELLER",
          createdAt: { $gte: startOfMonth },
          status: "COMPLETED",
        },
      },
      {
        $group: {
          _id: "$type",
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]);

    const monthlyCredited = monthlyStats.find((s) => s._id === "CREDIT")?.total || 0;
    const monthlyDebited = monthlyStats.find((s) => s._id === "DEBIT")?.total || 0;

    res.status(200).json({
      success: true,
      summary: {
        currentBalance: wallet.balance,
        totalCredited: wallet.totalCredited,
        totalDebited: wallet.totalDebited,
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
// CLIENT WALLET — NEW. Admin-only, since clients don't log in themselves.
// ══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/clients/:clientId/wallet ──────────────────────────────────────────
exports.getClientWallet = async (req, res) => {
  try {
    const { clientId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const client = await Client.findById(clientId).select("name walletBalance totalRefunded");
    if (!client) {
      return res.status(404).json({ success: false, message: "Client not found" });
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

// ─── GET /api/orders/:orderId/refund-transaction ────────────────────────────────
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
