const mongoose = require("mongoose");

// ── Return / Refund request ─────────────────────────────────────
// One document per return request. A request covers either a single
// item on an order (itemName = the item's name) or the whole order
// (itemName = "ALL").
//
// IMPORTANT — refund cap:
// productAmount / gstAmount are computed ONCE at creation time directly
// from the Order (order.subtotal / order.taxAmount, prorated per item
// for partial returns) and are never taken from client input. Every
// route that sets or pays out refundAmount re-validates it against
// productAmount before saving. GST, packaging, and shipping are never
// refundable — only the product's pre-tax value.
const returnSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    orderNumber: { type: String, required: true },

    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
    },

    buyer: {
      name:  { type: String, required: true },
      email: { type: String, default: "" },
      phone: { type: String, required: true },
    },

    // "ALL" = whole order returned. Otherwise, the exact item name from Order.items.
    itemName: { type: String, required: true },

    // Computed server-side from the order — see note above. Never trust client values for these.
    orderAmount:   { type: Number, required: true }, // productAmount + gstAmount, for display only
    productAmount: { type: Number, required: true }, // pure product value, excl. GST — the refund ceiling
    gstAmount:     { type: Number, required: true }, // GST portion — never refunded

    // Final amount approved / paid out. Must always be <= productAmount.
    refundAmount: { type: Number, default: 0 },

    reason: { type: String, required: true, trim: true },

    status: {
      type: String,
      enum: ["PENDING", "RECEIVED", "APPROVED", "REFUNDED", "REJECTED", "DISPUTED"],
      default: "PENDING",
    },

    requestedAt: { type: Date, default: Date.now },
    receivedAt:  { type: Date, default: null },
    resolvedAt:  { type: Date, default: null },

    notes:       { type: String, default: "", trim: true },
    disputeNote: { type: String, default: "", trim: true },

    images: [{ type: String }], // image URLs, if/when a submission flow uploads them

    statusHistory: [
      {
        status:    String,
        note:      String,
        changedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

returnSchema.index({ orderNumber: "text", "buyer.name": "text", itemName: "text" });
returnSchema.index({ status: 1, createdAt: -1 });
returnSchema.index({ sellerId: 1, createdAt: -1 });

module.exports = mongoose.model("Return", returnSchema);
