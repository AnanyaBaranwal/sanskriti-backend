const mongoose = require("mongoose");

const returnSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    orderNumber: { type: String, required: true },

    // NEW — resolved from order.clientId at creation time.
    // This is what lets /refund credit the correct client's wallet.
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      default: null, // null only for legacy orders that predate the Seller model
    },

    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
    },

    // Snapshot of buyer info at time of return (survives client record edits/merges)
    buyer: {
      name: { type: String, required: true },
      email: { type: String, default: "" },
      phone: { type: String, required: true },
    },

    // "ALL" = whole order returned, otherwise the specific item name
    itemName: { type: String, required: true, default: "ALL" },

    // Money — locked at creation time via computeRefundSplit(), never recalculated later.
    // productAmount is the hard refund ceiling. gstAmount is shown for transparency
    // only and is NEVER refunded (flat/order-level tax).
    orderAmount: { type: Number, required: true },   // productAmount + gstAmount, for display
    productAmount: { type: Number, required: true, min: [0, "Product amount cannot be negative"] },
    gstAmount: { type: Number, required: true, default: 0 },

    refundAmount: {
      type: Number,
      default: 0,
      validate: {
        validator: function (v) {
          return v <= this.productAmount;
        },
        message: "Refund amount cannot exceed the product amount",
      },
    },

    reason: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },
    disputeNote: { type: String, trim: true, default: "" },
    images: { type: [String], default: [] },

    status: {
      type: String,
      enum: ["PENDING", "RECEIVED", "APPROVED", "REJECTED", "DISPUTED", "REFUNDED"],
      default: "PENDING",
    },

    statusHistory: [
      {
        status: String,
        note: String,
        changedAt: { type: Date, default: Date.now },
      },
    ],

    receivedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

returnSchema.index({ sellerId: 1, createdAt: -1 });
returnSchema.index({ clientId: 1 });
returnSchema.index({ orderId: 1 });
returnSchema.index({ status: 1 });
returnSchema.index({ orderNumber: "text", "buyer.name": "text", "buyer.phone": "text", itemName: "text" });

module.exports = mongoose.model("Return", returnSchema);
