const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────
// Customer = a buyer who placed an order through a seller's storefront.
// This is intentionally a SEPARATE collection from Seller. A customer
// never logs in, never has a role, never appears in Seller Management.
// One customer can buy from multiple sellers, so we key uniqueness on
// (sellerId, phone) — i.e. "this phone number, as known to this seller."
// If you later want a single global customer identity across sellers,
// that's a bigger change (dedupe by phone alone) — flagging it here so
// it isn't forgotten, but not doing it now to keep this fix minimal.
// ─────────────────────────────────────────────────────────────────
const customerSchema = new mongoose.Schema(
  {
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      default: "Unknown",
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    address: {
      street: String,
      city: String,
      state: String,
      pincode: String,
    },

    // Cached stats — mirrors what clientStats.js used to compute onto Seller.
    // Kept here so the admin Orders/Customers UI can show these without
    // re-aggregating Order documents on every page load.
    totalOrders: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    returnedOrders: { type: Number, default: 0 },
    pendingPayments: { type: Number, default: 0 },
    lastOrderAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// A given phone number should only create one customer record per seller.
customerSchema.index({ sellerId: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model("Customer", customerSchema);
