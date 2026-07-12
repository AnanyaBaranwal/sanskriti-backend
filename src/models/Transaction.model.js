const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    walletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
    },
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
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
      // NOTE: "GALLERY_ORDER" added — used when wallet is debited for an
      // approved GalleryOrder (seller buying from the Sanskriti Gallery).
      enum: ["TOPUP", "ORDER_PAYMENT", "PAYOUT", "REFUND", "COMMISSION", "GALLERY_ORDER", "OTHER"],
      default: "OTHER",
    },
    status: {
      type: String,
      enum: ["PENDING", "COMPLETED", "FAILED", "REVERSED"],
      default: "COMPLETED",
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed, // extra info like orderId, paymentId etc
      default: {},
    },
  },
  { timestamps: true }
);

// Index for fast queries
transactionSchema.index({ sellerId: 1, createdAt: -1 });
transactionSchema.index({ walletId: 1, createdAt: -1 });

module.exports = mongoose.model("Transaction", transactionSchema);
