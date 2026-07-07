const mongoose = require("mongoose");

// ⚠️ Your Order collection has 430 REAL historical orders from an older
// system, with a completely different shape (orderId, userId, skuId, price,
// currency, deliveryPartner, trackingId, orderDate, status values like
// "IN_PROGRESS") than what the current app writes (sellerId, buyer, items,
// subtotal, total, orderNumber like "SNK-...").
//
// This version is deliberately PERMISSIVE so nothing about those 430 real
// orders can ever be corrupted or rejected by Mongoose:
//   1. `strict: false` — any field on a document that ISN'T declared in this
//      schema (orderId, userId, skuId, price, currency, deliveryPartner,
//      trackingId, orderDate, id, and anything else on legacy docs I haven't
//      even seen) is preserved as-is on every save, never silently dropped.
//   2. No `required: true` anywhere — legacy docs are missing sellerId,
//      buyer, subtotal, total entirely. Application-level validation (in
//      orderController.js / orders.admin.routes.js) already enforces what's
//      required for NEW orders created through the app; the schema itself
//      no longer blocks a legacy doc from being saved.
//   3. No `enum` on `status` or `platform` — legacy status values like
//      "IN_PROGRESS" (and possibly others I haven't seen across all 430)
//      must never fail validation. Each route already validates against its
//      own explicit `validStatuses` array before writing, so schema-level
//      enum enforcement was redundant anyway.
//
// I've also explicitly declared the legacy fields I've seen (orderId,
// userId, skuId, price, currency, deliveryPartner, trackingId, orderDate)
// so they show up cleanly with the right types — but even if some OTHER
// legacy order has a field I haven't seen, strict:false means it survives
// regardless.

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
  { strict: false } // preserve anything on legacy line items too
);

const orderSchema = new mongoose.Schema(
  {
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      default: null, // NOT required — legacy orders have none
    },

    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      default: null,
    },

    orderNumber: {
      type: String,
      unique: true,
      sparse: true, // allow legacy docs without one, and avoid unique-index conflicts on null
    },

    buyer: {
      name:  { type: String, trim: true }, // NOT required — legacy orders have no buyer object at all
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

    subtotal:        { type: Number, default: 0 }, // NOT required
    taxAmount:       { type: Number, default: 0 },
    discountAmount:  { type: Number, default: 0 },
    total:           { type: Number, default: 0 },  // NOT required

    status: {
      type: String, // no enum — legacy values like "IN_PROGRESS" must never fail validation
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
      type: String, // no enum — keep flexible, matches legacy "Amazon" fine either way
      default: null,
    },
    platformOrderId: { type: String, trim: true, default: "" },
    costTotal:       { type: Number, default: 0 },

    // ── Explicitly-declared legacy fields (seen on real historical orders) ──
    id:              { type: String },
    orderId:         { type: String },
    userId:          { type: String },
    skuId:           { type: String },
    price:           { type: Number },
    currency:        { type: String },
    deliveryPartner: { type: String },
    trackingId:      { type: String },
    orderDate:       { type: Date },
  },
  {
    timestamps: true,
    strict: false, // ← the real safety net: ANY field not declared above survives untouched on save
  }
);

// Only auto-generate an order number for NEW app-created orders that don't
// already have one — legacy docs already have their own (e.g. "ORD-...")
// and are left completely alone.
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
orderSchema.index({ clientId: 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ refundStatus: 1 });

module.exports = mongoose.model("Order", orderSchema);
