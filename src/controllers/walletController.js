const mongoose = require("mongoose");
const Wallet = require("../models/Wallet.model");
const Transaction = require("../models/Transaction.model");

// ─── Helper: get or create wallet ────────────────────────────────────────────
const getOrCreateWallet = async (sellerId) => {
  let wallet = await Wallet.findOne({ sellerId });
  if (!wallet) {
    wallet = await Wallet.create({ sellerId });
  }
  return wallet;
};

// ─── GET /api/wallet/balance ──────────────────────────────────────────────────
exports.getBalance = async (req, res) => {
  try {
    const wallet = await getOrCreateWallet(req.seller.id);

    // Get last 5 transactions for quick preview
    const recentTransactions = await Transaction.find({
      sellerId: req.seller.id,
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

// ─── GET /api/wallet/transactions ─────────────────────────────────────────────
exports.getTransactions = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const { type, category } = req.query;

    // Build filter
    const filter = { sellerId: req.seller.id };
    if (type) filter.type = type.toUpperCase();
    if (category) filter.category = category.toUpperCase();

    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
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

// ─── POST /api/wallet/credit ──────────────────────────────────────────────────
exports.credit = async (req, res) => {
  // Use MongoDB session for atomic transaction
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { amount, description, reference, category } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0",
      });
    }

    if (!description) {
      return res.status(400).json({
        success: false,
        message: "Description is required",
      });
    }

    // Get wallet inside session
    let wallet = await Wallet.findOne({ sellerId: req.seller.id }).session(session);
    if (!wallet) {
      wallet = await Wallet.create([{ sellerId: req.seller.id }], { session });
      wallet = wallet[0];
    }

    const balanceBefore = wallet.balance;
    const balanceAfter = balanceBefore + Number(amount);

    // Update wallet balance
    await Wallet.findByIdAndUpdate(
      wallet._id,
      {
        $inc: {
          balance: Number(amount),
          totalCredited: Number(amount),
        },
      },
      { session }
    );

    // Create transaction record
    const transaction = await Transaction.create(
      [
        {
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

    // Commit the transaction
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

// ─── POST /api/wallet/debit ───────────────────────────────────────────────────
exports.debit = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { amount, description, reference, category } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0",
      });
    }

    if (!description) {
      return res.status(400).json({
        success: false,
        message: "Description is required",
      });
    }

    // Get wallet
    const wallet = await Wallet.findOne({ sellerId: req.seller.id }).session(session);

    if (!wallet) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: "Wallet not found",
      });
    }

    // Check sufficient balance
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

    // Update wallet
    await Wallet.findByIdAndUpdate(
      wallet._id,
      {
        $inc: {
          balance: -Number(amount),
          totalDebited: Number(amount),
        },
      },
      { session }
    );

    // Create transaction record
    const transaction = await Transaction.create(
      [
        {
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

// ─── GET /api/wallet/summary ──────────────────────────────────────────────────
exports.getSummary = async (req, res) => {
  try {
    const wallet = await getOrCreateWallet(req.seller.id);

    // Get this month's totals
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const monthlyStats = await Transaction.aggregate([
      {
        $match: {
          sellerId: new mongoose.Types.ObjectId(req.seller.id),
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