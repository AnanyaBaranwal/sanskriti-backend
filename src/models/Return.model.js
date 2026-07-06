const mongoose = require("mongoose");

const returnSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
    },

    // Item being returned
    itemName: { type: String, required: true, trim: true },
    itemPrice: { type: Number, required: true }, // unit price at time of order
    quantity: { type: Number, required: true, min: 1 },

    // Money — locked at creation time, never recalculated later.
    // productAmount = item.total minus this item's proportional share of
    // order.discountAmount. Excludes tax and shipping entirely (flat/order-level
    // tax is never refunded on a partial return). This is the hard ceiling
    // that refundAmount can never exceed.
    productAmount: {
      type: Number,
      required: true,
      min: [0, "Product amount cannot be negative"],
    },
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

    status: {
      type: String,
      enum: ["PENDING", "RECEIVED", "APPROVED", "REJECTED", "DISPUTED", "REFUNDED"],
      default: "PENDING",
    },

    receivedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },

    // Set once the linked PayoutRequest (type: CLIENT_REFUND) is created
    payoutRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PayoutRequest",
      default: null,
    },
  },
  { timestamps: true }
);

returnSchema.index({ sellerId: 1, createdAt: -1 });
returnSchema.index({ clientId: 1 });
returnSchema.index({ orderId: 1 });
returnSchema.index({ status: 1 });

module.exports = mongoose.model("Return", returnSchema);
