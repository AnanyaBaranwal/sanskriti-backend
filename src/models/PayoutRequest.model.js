const mongoose = require("mongoose");

const payoutRequestSchema = new mongoose.Schema(
  {
    // ── Type — NEW ──────────────────────────────────────────────
    // SELLER_PAYOUT = seller withdraws wallet balance to their bank account
    // CLIENT_REFUND = admin credits a returned-order refund to a client's wallet
    type: {
      type: String,
      enum: ["SELLER_PAYOUT", "CLIENT_REFUND"],
      default: "SELLER_PAYOUT",
    },

    // Required only for SELLER_PAYOUT
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: function () {
        return this.type === "SELLER_PAYOUT";
      },
    },

    // Required only for CLIENT_REFUND — NEW
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      default: null,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    returnId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Return",
      default: null,
    },

    amount: {
      type: Number,
      required: true,
      min: [1, "Amount must be greater than 0"],
    },

    // Only required for SELLER_PAYOUT
    bankDetails: {
      accountNumber: {
        type: String,
        required: function () {
          return this.type === "SELLER_PAYOUT";
        },
      },
      ifscCode: {
        type: String,
        required: function () {
          return this.type === "SELLER_PAYOUT";
        },
      },
      accountName: { type: String },
      bankName: { type: String, default: "" },
    },

    status: {
      type: String,
      enum: ["PENDING", "PROCESSED", "REJECTED"],
      default: "PENDING",
    },

    sellerNote: { type: String, trim: true, default: "" },
    adminNote: { type: String, trim: true, default: "" },

    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    processedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

payoutRequestSchema.index({ sellerId: 1, status: 1 });
payoutRequestSchema.index({ clientId: 1 });
payoutRequestSchema.index({ type: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("PayoutRequest", payoutRequestSchema);
