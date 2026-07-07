const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  quantity:    { type: Number, required: true, min: 1 },
  price:       { type: Number, required: true, min: 0 },
  total:       { type: Number, required: true },
});

const orderSchema = new mongoose.Schema(
  {
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },

    // Link to Client model (set on create/backfill)
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      default: null,
    },

    orderNumber: {
      type: String,
      unique: true,
    },

    buyer: {
      name:  { type: String, required: true, trim: true },
      phone: { type: String, required: true },
      email: { type: String, trim: true, lowercase: true },
      address: {
        street:  String,
        city:    String,
        state:   String,
        pincode: String,
      },
    },

    items: [orderItemSchema],

    subtotal:        { type: Number, required: true }, // pure product cost (sum of item totals)
    taxAmount:       { type: Number, default: 0 },
    discountAmount:  { type: Number, default: 0 },
    total:           { type: Number, required: true }, // subtotal + tax - discount (+ packaging/shipping if included in items)

    status: {
      type: String,
      enum: ["PENDING", "CONFIRMED", "PROCESSING", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED"],
      default: "PENDING",
    },

    paymentStatus: {
      type: String,
      enum: ["UNPAID", "PAID", "REFUNDED"],
      default: "UNPAID",
    },

    paymentMethod: {
      type: String,
      enum: ["WALLET", "CASH", "ONLINE", "OTHER"],
      default: "OTHER",
    },

    notes: { type: String, trim: true },

    statusHistory: [
      {
        status:    String,
        changedAt: { type: Date, default: Date.now },
        note:      String,
      },
    ],

    // Return / refund fields (buyer-facing)
    returnReason:  { type: String, default: null },
    returnedAt:    { type: Date,   default: null },
    refundAmount:  { type: Number, default: 0 }, // amount refunded to the BUYER (unrelated to seller wallet)

    // ── Seller wallet debit — happens immediately when admin CONFIRMS the order ──
    walletDeducted:       { type: Boolean, default: false },
    walletDeductedAmount: { type: Number,  default: 0 }, // = order.total at time of confirmation

    // ── Seller wallet refund — only the product cost (subtotal), requires admin approval ──
    refundStatus: {
      type: String,
      enum: ["NONE", "PENDING", "APPROVED", "REJECTED"],
      default: "NONE",
    },
    refundEligibleAmount: { type: Number, default: 0 }, // = order.subtotal, set when flagged
    refundApprovedAt:     { type: Date,   default: null },
    refundApprovedBy:     { type: String, default: null },
    refundRejectedReason: { type: String, default: null },
    walletRefunded:       { type: Boolean, default: false }, // true once actually credited
    walletRefundedAmount: { type: Number,  default: 0 },
  },
  { timestamps: true }
);

// Auto-generate order number before saving
orderSchema.pre("save", async function (next) {
  if (!this.orderNumber) {
    const count = await mongoose.model("Order").countDocuments();
    const date  = new Date();
    const year  = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    this.orderNumber = `SNK-${year}${month}-${String(count + 1).padStart(4, "0")}`;
  }
  next();
});

// Text index for global search
orderSchema.index({ "buyer.name": "text", "buyer.phone": "text", orderNumber: "text" });

// Fast query indexes
orderSchema.index({ sellerId: 1, createdAt: -1 });
orderSchema.index({ clientId: 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ refundStatus: 1 });

module.exports = mongoose.model("Order", orderSchema);
