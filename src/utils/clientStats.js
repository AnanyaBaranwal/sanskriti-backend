const Seller = require("../models/Seller.model");
const Order  = require("../models/Order.model");

/**
 * Recalculate and save cached stats for a client.
 * Call this after any order is created, updated, or deleted.
 *
 * Usage:
 *   await refreshClientStats(clientId);
 */
const refreshClientStats = async (clientId) => {
  if (!clientId) return;
  try {
    const orders = await Order.find({ clientId }).lean();

    const totalOrders    = orders.length;
    const totalRevenue   = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const returnedOrders = orders.filter(o => o.status === "RETURNED").length;
    const sorted         = orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const lastOrderAt    = sorted[0]?.createdAt || null;

    // pendingPayments = sum of totals for orders with UNPAID bills
    // Simple approach: orders where paymentStatus is UNPAID
    const pendingPayments = orders
      .filter(o => o.paymentStatus === "UNPAID")
      .reduce((sum, o) => sum + (o.total || 0), 0);

    await Seller.findByIdAndUpdate(clientId, {
      totalOrders,
      totalRevenue,
      returnedOrders,
      pendingPayments,
      lastOrderAt,
    });
  } catch (err) {
    console.error("[refreshClientStats] Failed:", err.message);
  }
};

/**
 * Find or create a Seller from an order's buyer data.
 * Returns the client._id to store on the order.
 */
const findOrCreateClient = async ({ sellerId, buyer }) => {
  if (!buyer?.phone) return null;
  try {
    const client = await Seller.findOneAndUpdate(
      { sellerId, phone: buyer.phone },
      {
        $setOnInsert: {
          sellerId,
          name:    buyer.name  || "Unknown",
          phone:   buyer.phone,
          email:   buyer.email || null,
          address: buyer.address || {},
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return client._id;
  } catch (err) {
    console.error("[findOrCreateClient] Failed:", err.message);
    return null;
  }
};

module.exports = { refreshClientStats, findOrCreateClient };
