const Notification = require("../models/Notification.model");

/**
 * Create a notification for a seller.
 * Call this from any controller after an event happens — e.g. order
 * status change, wallet top-up, payout processed, KYC reviewed.
 *
 * Usage:
 *   const notify = require("../utils/notify");
 *   await notify({
 *     sellerId: order.sellerId,
 *     icon: "📦",
 *     title: `Order ${order.orderNumber} shipped`,
 *     desc: "Your order is on its way to the buyer",
 *     type: "ORDER",
 *     link: "/dashboard/orders",
 *   });
 *
 * This never throws — a notification failing to save should never break
 * the action that triggered it.
 */
const notify = async ({ sellerId, icon = "🔔", title, desc = "", type = "SYSTEM", link = null }) => {
  if (!sellerId || !title) return null;
  try {
    return await Notification.create({ sellerId, icon, title, desc, type, link });
  } catch (err) {
    console.error("[notify] Failed to create notification:", err.message);
    return null;
  }
};

module.exports = notify;
