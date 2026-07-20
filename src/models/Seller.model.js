const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const noteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    addedByName: { type: String },
  },
  { timestamps: true }
);

const sellerSchema = new mongoose.Schema(
  {
    // ── Identity / auth ──────────────────────────────────────────
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email"],
    },
    phone: {
      type: String,
      required: [true, "Phone is required"],
      match: [/^[6-9]\d{9}$/, "Please provide a valid Indian phone number"],
    },
    passwordHash: {
      type: String,
      required: true,
      select: false, // never returned in queries by default
    },
    role: {
      type: String,
      enum: ["seller"],
      default: "seller",
    },
    status: {
      type: String,
      enum: ["pending", "active", "suspended"],
      default: "pending",
    },
    kycStatus: {
      type: String,
      enum: ["not_submitted", "under_review", "approved", "rejected"],
      default: "not_submitted",
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerifyToken: String,
    emailVerifyExpires: Date,
    refreshToken: {
      type: String,
      select: false,
    },
    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
    },

    // ── Searchable business identifier ───────────────────────────
    // Auto-generated (e.g. SEL-0001) so admin can pull a seller record
    // by just searching this code.
    sellerId: {
      type: String,
      unique: true,
      index: true,
    },

    // ── Business details ─────────────────────────────────────────
    company: { type: String, trim: true, default: "" }, // e.g. "Rayeen Traders"
    gstNumber: { type: String, trim: true, default: "" },
    address: {
      street: String,
      city: String,
      state: String,
      pincode: String,
    },

    // ── Internal admin notes ──────────────────────────────────────
    notes: [noteSchema],

    // ── Cached order/revenue stats ───────────────────────────────
    totalOrders: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    pendingPayments: { type: Number, default: 0 },
    returnedOrders: { type: Number, default: 0 },
    lastOrderAt: { type: Date, default: null },

    // ── Wallet ──────────────────────────────────────────────────
    walletBalance: {
      type: Number,
      default: 0,
      min: [0, "Wallet balance cannot be negative"],
    },
    totalRefunded: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Auto-generate sellerId (SEL-0001, SEL-0002, ...)
sellerSchema.pre("save", async function (next) {
  if (!this.sellerId) {
    const count = await mongoose.model("Seller").countDocuments();
    this.sellerId = `SEL-${String(count + 1).padStart(4, "0")}`;
  }
  if (this.isModified("passwordHash") && this.passwordHash) {
    const salt = await bcrypt.genSalt(12);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
  }
  next();
});

// Instance method to compare passwords
sellerSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.passwordHash);
};

// Never return passwordHash or tokens in JSON responses
sellerSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.refreshToken;
  delete obj.emailVerifyToken;
  delete obj.emailVerifyExpires;
  delete obj.passwordResetToken;
  delete obj.passwordResetExpires;
  return obj;
};

sellerSchema.virtual("returnPercent").get(function () {
  if (!this.totalOrders) return 0;
  return Math.round((this.returnedOrders / this.totalOrders) * 100);
});
sellerSchema.set("toJSON", { virtuals: true });
sellerSchema.set("toObject", { virtuals: true });

sellerSchema.index({ phone: 1 });
sellerSchema.index({ name: "text", phone: "text", email: "text", company: "text" });

module.exports = mongoose.model("Seller", sellerSchema, "sellers");
