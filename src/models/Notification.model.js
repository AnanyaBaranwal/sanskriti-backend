const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "Seller", required: true, index: true },
    icon:  { type: String, default: "🔔" },
    title: { type: String, required: true, trim: true },
    desc:  { type: String, default: "", trim: true },
    type:  { type: String, enum: ["ORDER", "WALLET", "BILL", "KYC", "PAYOUT", "SYSTEM"], default: "SYSTEM" },
    link:  { type: String, default: null },
    read:  { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false }
);

notificationSchema.index({ sellerId: 1, createdAt: -1 });
notificationSchema.index({ sellerId: 1, read: 1 });

module.exports = mongoose.model("Notification", notificationSchema);
