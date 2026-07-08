const mongoose = require("mongoose");

const kycSchema = new mongoose.Schema(
  {
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
      unique: true, // one KYC record per seller
      index: true,
    },

    panNumber:   { type: String, uppercase: true, trim: true },
    panDocument: String,

    aadharNumber:   String,
    aadharDocument: String,

    bankAccountNumber: String,
    bankIFSC:          { type: String, uppercase: true, trim: true },
    bankAccountName:   String,
    cancelledCheque:   String,

    status: {
      type: String,
      enum: ["not_submitted", "under_review", "approved", "rejected"],
      default: "not_submitted",
    },

    submittedAt: Date,

    // Admin review audit trail
    adminNote:  String,
    reviewedAt: Date,
    reviewedBy: String, // admin name at time of decision
  },
  { timestamps: true }
);

kycSchema.index({ status: 1 });

// Explicit collection name: "kyc" (own collection, separate from "sellers")
module.exports = mongoose.model("Kyc", kycSchema, "kyc");
