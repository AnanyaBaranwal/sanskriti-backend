const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const noteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Client" },
    addedByName: { type: String },
  },
  { timestamps: true }
);

const clientSchema = new mongoose.Schema(
  {
    // ── Identity / auth ──────────────────────────────────────────
    name:  { type: String, required: true, trim: true },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email"],
    },
    phone: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true, select: false },

    // Auth role — separate from clientType (business tier) below
    role: {
      type: String,
      enum: ["seller", "admin", "manager", "employee"],
      default: "seller",
    },

    status: {
      type: String,
      enum: ["pending", "active", "suspended", "inactive"],
      default: "pending",
    },

    isEmailVerified: { type: Boolean, default: false },
    emailVerifyToken: String,
    emailVerifyExpires: Date,
    refreshToken: { type: String, select: false },
    passwordResetToken: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },

    // ── Searchable business identifier ───────────────────────────
    // Auto-generated (e.g. SEL-0001) so admin can pull a full client
    // record by just searching this code.
    sellerId: {
      type: String,
      unique: true,
      index: true,
    },

    // ── Business / company details ───────────────────────────────
    company:   { type: String, trim: true, default: "" }, // e.g. "Ims Traders"
    gstNumber: { type: String, trim: true, default: "" },
    address: {
      street:  String,
      city:    String,
      state:   String,
      pincode: String,
    },

    // ── Business tier (renamed from old "role") ──────────────────
    clientType: {
      type: String,
      enum: ["customer", "wholesale", "vip"],
      default: "customer",
    },

    // ── KYC status snapshot (full docs live in Kyc model) ────────
    kycStatus: {
      type: String,
      enum: ["not_submitted", "under_review", "approved", "rejected"],
      default: "not_submitted",
    },

    // ── Internal notes ────────────────────────────────────────────
    notes: [noteSchema],

    // ── Cached order/revenue stats ───────────────────────────────
    totalOrders:     { type: Number, default: 0 },
    totalRevenue:    { type: Number, default: 0 },
    pendingPayments: { type: Number, default: 0 },
    returnedOrders:  { type: Number, default: 0 },
    lastOrderAt:     { type: Date, default: null },

    // ── Wallet ────────────────────────────────────────────────────
    walletBalance: { type: Number, default: 0, min: [0, "Wallet balance cannot be negative"] },
    totalRefunded: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

// Auto-generate sellerId (SEL-0001, SEL-0002, ...)
clientSchema.pre("save", async function (next) {
  if (!this.sellerId) {
    const count = await mongoose.model("Client").countDocuments();
    this.sellerId = `SEL-${String(count + 1).padStart(4, "0")}`;
  }
  if (this.isModified("passwordHash") && this.passwordHash) {
    const salt = await bcrypt.genSalt(12);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
  }
  next();
});

clientSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.passwordHash);
};

clientSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.refreshToken;
  delete obj.emailVerifyToken;
  delete obj.emailVerifyExpires;
  delete obj.passwordResetToken;
  delete obj.passwordResetExpires;
  return obj;
};

clientSchema.virtual("returnPercent").get(function () {
  if (!this.totalOrders) return 0;
  return Math.round((this.returnedOrders / this.totalOrders) * 100);
});
clientSchema.set("toJSON", { virtuals: true });
clientSchema.set("toObject", { virtuals: true });

clientSchema.index({ phone: 1 });
clientSchema.index({ name: "text", phone: "text", email: "text", company: "text" });

module.exports = mongoose.model("Client", clientSchema);