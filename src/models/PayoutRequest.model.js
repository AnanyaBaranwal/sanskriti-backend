const mongoose = require("mongoose");

const payoutRequestSchema = new mongoose.Schema(
  {
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: [100, "Minimum payout amount is ₹100"],
    },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "PROCESSED"],
      default: "PENDING",
    },
    bankDetails: {
      accountNumber: {
        type: String,
        required: true,
      },
      ifscCode: {
        type: String,
        required: true,
        uppercase: true,
      },
      accountName: {
        type: String,
        required: true,
      },
      bankName: String,
    },
    adminNote: {
      type: String,
      trim: true,
    },
    sellerNote: {
      type: String,
      trim: true,
    },
    processedAt: Date,
    rejectedAt: Date,
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
    },
  },
  { timestamps: true }
);

// Index for fast admin queries
payoutRequestSchema.index({ status: 1, createdAt: -1 });
payoutRequestSchema.index({ sellerId: 1, createdAt: -1 });

module.exports = mongoose.model("PayoutRequest", payoutRequestSchema);