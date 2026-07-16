const mongoose = require("mongoose");

// ⚠️ All legacy pre-app historical orders have been deleted by the team, so
// the extreme legacy-permissiveness this schema used to need is no longer
// load-bearing. I'm leaving `strict: false` and the loosely-typed `status`/
// `platform` fields in place anyway — they're harmless for new orders and
// cheap insurance if another bulk import ever happens — but nothing here
// depends on legacy shape anymore.
//
// KEY CHANGE: `clientId` (which pointed at the Seller collection — the bug
// that caused buyers to be upserted into Seller) has been replaced with
// `customerId`, which points at the new, separate Customer collection.
// `sellerId` is unchanged — it always meant "which real seller sold this."

const orderItemSchema = new mongoose.Schema(
  {
    name:        { type: String, trim: true },
    description: { type: String, trim: true },
    quantity:    { type: Number, min: 1 },
    price:       { type: Number, min: 0 }, // seller's SELLING price per unit
    total:       { type: Number },          // price * quantity

    // ── Gallery sourcing (optional — old/manual/bulk-upload orders won't have these) ──
    galleryProductId: { type: mongoose.Schema.Types.ObjectId, ref: "GalleryProduct", default: null },
    costPrice:        { type: Number, default: 0 }, // pure cost price per unit, snapshotted at order time
  },
  { strict: false }
);

const orderSchema = new mongoose.Schema(
  {
    // Who SOLD this — always a real Seller.
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      default: null,
    },

    // Who BOUGHT this — always a Customer, never a Seller.
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },

    orderNumber: {
      type: String,
      unique: true,
      sparse: true,
    },

    buyer: {
      name:  { type: String, trim: true },
      phone: { type: String },
      email: { type: String, trim: true, lowercase: true },
      address: {
        street:  String,
        city:    String,
        state:   String,
        pincode: String,
      },
    },

    items: [orderItemSchema],

    subtotal:        { type: Number, default: 0 },
    taxAmount:       { type: Number, default: 0 },
    discountAmount:  { type: Number, default: 0 },
    total:           { type: Number, default: 0 },

    status: {
      type: String,
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

    // ── Return / refund (buyer-side) ────────────────────────────────────
    returnReason:  { type: String, default: null },
    returnedAt:    { type: Date,   default: null },
    refundAmount:  { type: Number, default: 0 },

    // ── Seller-wallet debit tracking ─────────────────────────────────────
    walletDeducted:       { type: Boolean, default: false },
    walletDeductedAmount: { type: Number,  default: 0 },

    // ── Seller-wallet refund tracking ────────────────────────────────────
    refundStatus:         { type: String, enum: ["NONE", "PENDING", "APPROVED", "REJECTED"], default: "NONE" },
    refundEligibleAmount: { type: Number, default: 0 },
    walletRefunded:       { type: Boolean, default: false },

    // ── Gallery sourcing ──────────────────────────────────────────────────
    platform: {
      type: String,
      default: null,
    },
    platformOrderId: { type: String, trim: true, default: "" },
    costTotal:       { type: Number, default: 0 },
  },
  {
    timestamps: true,
    strict: false,
  }
);

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

orderSchema.index({ "buyer.name": "text", "buyer.phone": "text", orderNumber: "text" });
orderSchema.index({ sellerId: 1, createdAt: -1 });
orderSchema.index({ customerId: 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ refundStatus: 1 });

module.exports = mongoose.model("Order", orderSchema);
