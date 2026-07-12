const mongoose = require("mongoose");

const walletSchema = new mongoose.Schema(
  {
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
      unique: true, // one wallet per seller
    },
    balance: {
      type: Number,
      default: 0,
      min: [0, "Balance cannot be negative"],
    },
    currency: {
      type: String,
      default: "INR",
    },
    totalCredited: {
      type: Number,
      default: 0, // lifetime total money added
    },
    totalDebited: {
      type: Number,
      default: 0, // lifetime total money spent
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Wallet", walletSchema);