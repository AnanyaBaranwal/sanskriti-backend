const Order = require("../models/Order.model");
const mongoose = require("mongoose");
const GalleryProduct = require("../models/GalleryProduct.model");
const Wallet = require("../models/Wallet.model");
const { findOrCreateCustomer, refreshCustomerStats } = require("../utils/clientStats");
const { checkSellerEligibility, eligibilityMessage } = require("../utils/sellerEligibility");

// ── Helper: calculate totals ──────────────────────────────────
const calculateTotals = (items, taxPercent = 0, discount = 0) => {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const taxAmount = Math.round((subtotal * taxPercent) / 100);
  const discountAmount = Number(discount) || 0;
  const total = subtotal + taxAmount - discountAmount;
  return { subtotal, taxAmount, discountAmount, total };
};

// ── POST /api/orders ──────────────────────────────────────────
exports.createOrder = async (req, res) => {
  try {
    // Gate placing an order behind the same eligibility check as wallet
    // recharge (see utils/sellerEligibility.js) — complete profile
    // (business, address, bank details) + approved KYC.
    const eligibility = await checkSellerEligibility(req.seller.id);
    if (!eligibility.eligible) {
      return res.status(403).json({
        success: false,
        message: eligibilityMessage(eligibility),
        eligibility,
      });
    }

    const { buyer, items, platform, platformOrderId, taxPercent, discountAmount, paymentMethod, notes } = req.body;

    if (!buyer?.name || !buyer?.phone) {
      return res.status(400).json({ success: false, message: "Buyer name and phone are required" });
    }
    if (!buyer?.address?.street || !buyer?.address?.city || !buyer?.address?.state || !buyer?.address?.pincode) {
      return res.status(400).json({ success: false, message: "Complete shipping address is required" });
    }
    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: "At least one item is required" });
    }
    if (!platform) {
      return res.status(400).json({ success: false, message: "Please select which platform this order came from" });
    }
    for (const item of items) {
      if (!item.galleryProductId || !item.quantity || item.price === undefined || item.price === null) {
        return res.status(400).json({ success: false, message: "Each item needs a gallery product, quantity, and your selling price" });
      }
    }

    const galleryProductIds = items.map(i => i.galleryProductId);
    const galleryProducts = await GalleryProduct.find({ _id: { $in: galleryProductIds }, isActive: true });

    if (galleryProducts.length !== new Set(galleryProductIds.map(String)).size) {
      return res.status(400).json({ success: false, message: "One or more products are no longer available in the gallery" });
    }

    let processedItems;
    try {
      processedItems = items.map(reqItem => {
        const gp = galleryProducts.find(p => String(p._id) === String(reqItem.galleryProductId));
        if (gp.inStock === false) {
          throw new Error(`"${gp.name}" is currently out of stock`);
        }
        const quantity = Math.max(1, Number(reqItem.quantity) || 1);
        const price = Number(reqItem.price);
        return {
          name: gp.name,
          description: gp.description || "",
          quantity,
          price,
          total: price * quantity,
          galleryProductId: gp._id,
          costPrice: gp.costPrice,
        };
      });
    } catch (stockErr) {
      return res.status(400).json({ success: false, message: stockErr.message });
    }

    const { subtotal, taxAmount, discountAmount: discount, total } = calculateTotals(
      processedItems,
      taxPercent || 0,
      discountAmount || 0
    );

    const costTotal = processedItems.reduce((sum, i) => sum + i.costPrice * i.quantity, 0);

    const wallet = await Wallet.findOne({ sellerId: req.seller.id });
    const insufficientBalance = !wallet || wallet.balance < costTotal;

    const order = await Order.create({
      sellerId: req.seller.id,
      buyer,
      items: processedItems,
      subtotal,
      taxAmount,
      discountAmount: discount,
      total,
      costTotal,
      platform,
      platformOrderId: platformOrderId || "",
      paymentMethod: paymentMethod || "OTHER",
      notes: notes || "",
      statusHistory: [{ status: "PENDING", note: "Order created — pending admin confirmation before gallery stock is charged" }],
    });

    // Link to customer — buyers now live in the Customer collection, never Seller.
    const customerId = await findOrCreateCustomer({ sellerId: req.seller.id, buyer: order.buyer });
    if (customerId) {
      await Order.findByIdAndUpdate(order._id, { customerId });
      await refreshCustomerStats(customerId);
    }

    res.status(201).json({
      success: true,
      message: insufficientBalance
        ? `Order created — pending admin confirmation. Note: your wallet balance (₹${wallet?.balance || 0}) is currently below the cost total (₹${costTotal}); please top up before admin confirms it.`
        : "Order created successfully",
      insufficientBalance,
      order,
    });
  } catch (error) {
    console.error("Create order error:", error);
    res.status(400).json({ success: false, message: error.message || "Server error" });
  }
};

// ── GET /api/orders ───────────────────────────────────────────
exports.getOrders = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const { status, search, from, to } = req.query;

    const filter = { sellerId: req.seller.id };

    if (status) filter.status = status.toUpperCase();

    if (search) {
      filter.$or = [
        { orderNumber: { $regex: search, $options: "i" } },
        { "buyer.name": { $regex: search, $options: "i" } },
        { "buyer.phone": { $regex: search, $options: "i" } },
      ];
    }

    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Order.countDocuments(filter),
    ]);

    const stats = await Order.aggregate([
      { $match: { sellerId: new mongoose.Types.ObjectId(req.seller.id) } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          revenue: { $sum: "$total" },
        },
      },
    ]);

    res.status(200).json({
      success: true,
      orders,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      stats,
    });
  } catch (error) {
    console.error("Get orders error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── GET /api/orders/:id ───────────────────────────────────────
exports.getOrderById = async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      sellerId: req.seller.id,
    });

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    res.status(200).json({ success: true, order });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── PATCH /api/orders/:id/status ──────────────────────────────
exports.updateOrderStatus = async (req, res) => {
  try {
    const { status, note } = req.body;

    const validStatuses = ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"];
    if (!validStatuses.includes(status?.toUpperCase())) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    const order = await Order.findOne({ _id: req.params.id, sellerId: req.seller.id });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const statusFlow = ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"];
    const currentIdx = statusFlow.indexOf(order.status);
    const newIdx = statusFlow.indexOf(status.toUpperCase());

    if (status.toUpperCase() !== "CANCELLED" && newIdx < currentIdx) {
      return res.status(400).json({
        success: false,
        message: `Cannot change status from ${order.status} back to ${status.toUpperCase()}`,
      });
    }

    order.status = status.toUpperCase();
    order.statusHistory.push({
      status: status.toUpperCase(),
      note: note || `Status updated to ${status}`,
      changedAt: new Date(),
    });

    await order.save();

    res.status(200).json({
      success: true,
      message: `Order status updated to ${status.toUpperCase()}`,
      order,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── PATCH /api/orders/:id ─────────────────────────────────────
exports.updateOrder = async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, sellerId: req.seller.id });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    if (order.status !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: "Only PENDING orders can be edited",
      });
    }

    const allowedFields = ["buyer", "items", "notes", "paymentMethod", "paymentStatus", "taxPercent", "discountAmount"];
    const updates = {};
    allowedFields.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    if (updates.items) {
      updates.items = updates.items.map((item) => ({ ...item, total: item.price * item.quantity }));
      const totals = calculateTotals(updates.items, req.body.taxPercent || 0, req.body.discountAmount || 0);
      Object.assign(updates, totals);
    }

    const updated = await Order.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true, runValidators: true });

    res.status(200).json({ success: true, message: "Order updated", order: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── DELETE /api/orders/:id ────────────────────────────────────
exports.deleteOrder = async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, sellerId: req.seller.id });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (!["PENDING", "CANCELLED"].includes(order.status)) {
      return res.status(400).json({ success: false, message: "Only PENDING or CANCELLED orders can be deleted" });
    }
    await Order.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: "Order deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ── GET /api/orders/stats/summary ────────────────────────────
exports.getOrderStats = async (req, res) => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [overall, monthly] = await Promise.all([
      Order.aggregate([
        { $match: { sellerId: new mongoose.Types.ObjectId(req.seller.id) } },
        { $group: { _id: "$status", count: { $sum: 1 }, revenue: { $sum: "$total" } } },
      ]),
      Order.aggregate([
        { $match: { sellerId: new mongoose.Types.ObjectId(req.seller.id), createdAt: { $gte: startOfMonth } } },
        { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: "$total" } } },
      ]),
    ]);

    const totalRevenue = overall.reduce((sum, s) => sum + (s._id !== "CANCELLED" ? s.revenue : 0), 0);
    const totalOrders = overall.reduce((sum, s) => sum + s.count, 0);

    res.status(200).json({
      success: true,
      stats: {
        overall,
        totalOrders,
        totalRevenue,
        thisMonth: monthly[0] || { count: 0, revenue: 0 },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};
