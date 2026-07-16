const Customer = require("../models/Customer.model");
const Order    = require("../models/Order.model");

/**
 * Recalculate and save cached stats for a CUSTOMER (buyer).
 * Call this after any order is created, updated, or deleted.
 *
 * NOTE: this used to write onto the Seller collection — that was a bug.
 * Buyers are never sellers; they now live in their own Customer collection.
 *
 * Usage:
 *   await refreshCustomerStats(customerId);
 */
const refreshCustomerStats = async (customerId) => {
  if (!customerId) return;
  try {
    const orders = await Order.find({ customerId }).lean();

    const totalOrders    = orders.length;
    const totalRevenue   = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const returnedOrders = orders.filter(o => o.status === "RETURNED").length;
    const sorted         = orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const lastOrderAt    = sorted[0]?.createdAt || null;

    // pendingPayments = sum of totals for orders with UNPAID bills
    const pendingPayments = orders
      .filter(o => o.paymentStatus === "UNPAID")
      .reduce((sum, o) => sum + (o.total || 0), 0);

    await Customer.findByIdAndUpdate(customerId, {
      totalOrders,
      totalRevenue,
      returnedOrders,
      pendingPayments,
      lastOrderAt,
    });
  } catch (err) {
    console.error("[refreshCustomerStats] Failed:", err.message);
  }
};

/**
 * Find or create a Customer from an order's buyer data.
 * Returns the customer._id to store on the order (as order.customerId).
 *
 * This is the function that used to upsert into the Seller collection —
 * fixed to use Customer instead, so buyers never pollute Seller Management.
 */
const findOrCreateCustomer = async ({ sellerId, buyer }) => {
  if (!buyer?.phone) return null;
  try {
    const customer = await Customer.findOneAndUpdate(
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
    return customer._id;
  } catch (err) {
    console.error("[findOrCreateCustomer] Failed:", err.message);
    return null;
  }
};

module.exports = { refreshCustomerStats, findOrCreateCustomer };
