const mongoose = require("mongoose");

const movementSchema = new mongoose.Schema(
  {
    type:      { type: String, enum: ["IN", "OUT", "ADJUSTMENT", "RETURN"], required: true },
    quantity:  { type: Number, required: true },           // positive = in, negative = out
    reason:    { type: String, trim: true },               // "Sale", "Purchase", "Damaged", etc.
    orderId:   { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    recordedBy:{ type: mongoose.Schema.Types.ObjectId, ref: "Client" },
    stockAfter:{ type: Number },                           // stock level after this movement
  },
  { timestamps: true }
);

const productSchema = new mongoose.Schema(
  {
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },

    name:     { type: String, required: true, trim: true },
    sku:      { type: String, trim: true, uppercase: true },
    category: { type: String, trim: true },
    description: { type: String, trim: true },
    imageUrl: { type: String },

    // Pricing
    costPrice:    { type: Number, default: 0, min: 0 },
    sellingPrice: { type: Number, default: 0, min: 0 },

    // Stock
    stock:        { type: Number, default: 0, min: 0 },
    reorderLevel: { type: Number, default: 5 },     // alert when stock <= this

    // Tracking
    lastSoldAt:   { type: Date, default: null },
    totalSold:    { type: Number, default: 0 },     // cumulative units sold

    // Movement history (last 100 kept for performance)
    movementHistory: { type: [movementSchema], default: [] },

    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Virtuals
productSchema.virtual("stockStatus").get(function () {
  if (this.stock === 0)                     return "OUT_OF_STOCK";
  if (this.stock <= this.reorderLevel)      return "LOW_STOCK";
  return "IN_STOCK";
});

productSchema.virtual("needsReorder").get(function () {
  return this.stock <= this.reorderLevel;
});

productSchema.set("toJSON",   { virtuals: true });
productSchema.set("toObject", { virtuals: true });

// Indexes
productSchema.index({ sellerId: 1, isActive: 1 });
productSchema.index({ sellerId: 1, stock: 1 });
productSchema.index({ lastSoldAt: 1 });
productSchema.index({ name: "text", sku: "text", category: "text" }); // global search

module.exports = mongoose.model("Product", productSchema);
