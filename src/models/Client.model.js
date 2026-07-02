const mongoose = require("mongoose");

const noteSchema = new mongoose.Schema(
  {
    text:        { type: String, required: true, trim: true },
    addedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "Seller" },
    addedByName: { type: String },
  },
  { timestamps: true }
);

const clientSchema = new mongoose.Schema(
  {
    // Core identity — extracted from order buyer, or added manually by admin
    name:  { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true, default: null },

    // Business / company details (shown in User Management style table)
    company:   { type: String, trim: true, default: "" },
    gstNumber: { type: String, trim: true, uppercase: true, default: "" },

    address: {
      street:  String,
      city:    String,
      state:   String,
      pincode: String,
    },

    // Which seller this client belongs to
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
    },

    // Wallet balance held for this client (advance / credit note balance)
    walletBalance: { type: Number, default: 0 },

    // Account status — shown as Active/Inactive badge
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },

    // Fixed role label for now — all Client records are marketplace customers.
    // Kept as a real field (rather than hardcoded in the UI) so it can be
    // extended later (e.g. "wholesale", "vip") without another migration.
    role: {
      type: String,
      enum: ["customer", "wholesale", "vip"],
      default: "customer",
    },

    // Internal notes added by admin/seller
    notes: [noteSchema],

    // Cached stats — updated whenever an order is created/updated
    // (avoids expensive aggregation on every client list load)
    totalOrders:     { type: Number, default: 0 },
    totalRevenue:    { type: Number, default: 0 },
    pendingPayments: { type: Number, default: 0 }, // sum of unpaid bill totals
    returnedOrders:  { type: Number, default: 0 },
    lastOrderAt:     { type: Date,   default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Virtual: return percentage
clientSchema.virtual("returnPercent").get(function () {
  if (!this.totalOrders) return 0;
  return Math.round((this.returnedOrders / this.totalOrders) * 100);
});

clientSchema.set("toJSON",   { virtuals: true });
clientSchema.set("toObject", { virtuals: true });

// Unique client per seller by phone
clientSchema.index({ sellerId: 1, phone: 1 }, { unique: true });
clientSchema.index({ sellerId: 1, name: 1 });
clientSchema.index({ phone: 1 });
clientSchema.index({ status: 1 });

// Text index for global search — now includes company + GST
clientSchema.index({ name: "text", phone: "text", email: "text", company: "text", gstNumber: "text" });

module.exports = mongoose.model("Client", clientSchema);
