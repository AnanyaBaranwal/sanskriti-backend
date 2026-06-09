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
      ref: "Seller",
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

    subtotal:        { type: Number, required: true },
    taxAmount:       { type: Number, default: 0 },
    discountAmount:  { type: Number, default: 0 },
    total:           { type: Number, required: true },

    status: {
      type: String,
      // Added PACKED and RETURNED to the original enum
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

    // Return / refund fields
    returnReason:  { type: String, default: null },
    returnedAt:    { type: Date,   default: null },
    refundAmount:  { type: Number, default: 0 },
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

module.exports = mongoose.model("Order", orderSchema);
