const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    // Who did it
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
    },
    performedByName: { type: String },   // snapshot so it survives account deletion
    performedByRole: { type: String },

    // What they did
    action: {
      type: String,
      enum: ["CREATE", "UPDATE", "DELETE", "STATUS_CHANGE", "EXPORT", "LOGIN", "LOGOUT", "OTHER"],
      required: true,
    },

    // What entity was affected
    entity: {
      type: String,
      // NOTE: "GalleryProduct" and "GalleryOrder" added for the seller Gallery feature.
      enum: ["Order", "Bill", "Seller", "Product", "Seller", "Payout", "Wallet", "GalleryProduct", "GalleryOrder", "System"],
      required: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    entityRef: { type: String }, // human-readable ref e.g. order number, invoice number

    // What changed
    description: { type: String, required: true }, // plain-English description
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after:  { type: mongoose.Schema.Types.Mixed, default: null },

    // Request context
    ip:        { type: String },
    userAgent: { type: String },
  },
  {
    timestamps: true,  // createdAt = when it happened
    versionKey: false,
  }
);

// Indexes for fast filtering on the activity log page
auditLogSchema.index({ performedBy: 1, createdAt: -1 });
auditLogSchema.index({ entity: 1, entityId: 1 });
auditLogSchema.index({ action: 1 });
auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
