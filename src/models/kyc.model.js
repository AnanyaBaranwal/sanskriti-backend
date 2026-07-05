const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const sellerSchema = new mongoose.Schema(
  {
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
      enum: ["seller", "admin"],
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
    // Business details (filled later during KYC)
    businessName: String,
    gstNumber: String,
    address: {
      street: String,
      city: String,
      state: String,
      pincode: String,
    },
    kyc: {
      panNumber: {
        type: String,
        uppercase: true,
        trim: true,
      },
      panDocument: String,
      aadharNumber: String,
      aadharDocument: String,
      bankAccountNumber: String,
      bankIFSC: {
        type: String,
        uppercase: true,
        trim: true,
      },
      bankAccountName: String,
      cancelledCheque: String,
      submittedAt: Date,
      // ── Admin review audit trail ──
      adminNote: String,
      reviewedAt: Date,
      reviewedBy: String, // admin name at time of decision
    },
    profilePhoto: String,
  },
  {
    timestamps: true,
  }
);

// Hash password before saving
sellerSchema.pre("save", async function (next) {
  if (!this.isModified("passwordHash")) return next();
  const salt = await bcrypt.genSalt(12);
  this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
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
  return obj;
};

module.exports = mongoose.model("Seller", sellerSchema);
