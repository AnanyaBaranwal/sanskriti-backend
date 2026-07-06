const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    // Whose wallet this transaction belongs to
    walletOwnerType: {
      type: String,
      enum: ["SELLER", "CLIENT"],
      required: true,
      default: "SELLER",
    },

    walletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      default: null, // only used for SELLER transactions (Wallet doc)
    },
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      default: null, // set for SELLER transactions
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      default: null, // set for CLIENT transactions (refunds credited to wallet)
    },

    type: {
      type: String,
      enum: ["CREDIT", "DEBIT"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: [1, "Amount must be at least 1"],
    },
    balanceBefore: {
      type: Number,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    reference: {
      type: String,
      trim: true, // payment gateway reference ID
    },
    category: {
      type: String,
      enum: ["TOPUP", "ORDER_PAYMENT", "PAYOUT", "REFUND", "COMMISSION", "OTHER"],
      default: "OTHER",
    },
    status: {
      type: String,
      enum: ["PENDING", "COMPLETED", "FAILED", "REVERSED"],
      default: "COMPLETED",
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed, // e.g. { orderId, payoutRequestId, returnId }
      default: {},
    },
  },
  { timestamps: true }
);

// Indexes for fast queries
transactionSchema.index({ sellerId: 1, createdAt: -1 });
transactionSchema.index({ walletId: 1, createdAt: -1 });
transactionSchema.index({ clientId: 1, createdAt: -1 });
transactionSchema.index({ "metadata.orderId": 1 });

module.exports = mongoose.model("Transaction", transactionSchema);
