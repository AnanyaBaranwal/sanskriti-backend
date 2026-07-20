// ═══════════════════════════════════════════════════════════════
// FILE: src/routes/admin/bulkinvoice.admin.routes.js
// Bulk invoice generation
// ═══════════════════════════════════════════════════════════════
const express = require("express");
const router  = express.Router();
const Order   = require("../../models/Order.model");
const Bill    = require("../../models/Bill.model");
const { logAction } = require("../../utils/audit");
const { protectStaff, restrictStaffTo } = require("../../middleware/staffAuth.middleware");

router.use(protectStaff, restrictStaffTo("admin"));

// POST /api/admin/bulk-invoice/generate
// Body: { orderIds: [...] } OR { status: "DELIVERED", dateFrom, dateTo }
router.post("/generate", async (req, res) => {
  try {
    const { orderIds, status, dateFrom, dateTo } = req.body;

    let orders;
    if (orderIds?.length) {
      orders = await Order.find({ _id: { $in: orderIds } }).lean();
    } else {
      const filter = {};
      if (status) filter.status = status;
      if (dateFrom || dateTo) {
        filter.createdAt = {};
        if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
        if (dateTo)   filter.createdAt.$lte = new Date(dateTo);
      }
      orders = await Order.find(filter).lean();
    }

    if (!orders.length)
      return res.status(400).json({ success: false, message: "No orders found" });

    const results = { generated: 0, skipped: 0, failed: 0, invoices: [], errors: [] };

    for (const order of orders) {
      try {
        // Check if bill already exists
        const existing = await Bill.findOne({ orderId: order._id });
        if (existing) {
          results.skipped++;
          continue;
        }

        const invoiceNumber = `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
        const subtotal  = order.items?.reduce((s, i) => s + i.total, 0) || order.total || 0;
        const taxRate   = 0.18;
        const taxAmount = Math.round(subtotal * taxRate);
        const isInter   = order.buyer?.address?.state && order.buyer.address.state !== "Uttar Pradesh";

        const bill = await Bill.create({
          orderId:       order._id,
          sellerId:      order.sellerId,
          invoiceNumber,
          buyer:         order.buyer,
          items:         order.items || [],
          subtotal,
          cgst:          isInter ? 0 : Math.round(taxAmount / 2),
          sgst:          isInter ? 0 : Math.round(taxAmount / 2),
          igst:          isInter ? taxAmount : 0,
          totalTax:      taxAmount,
          grandTotal:    subtotal + taxAmount,
          paymentStatus: order.paymentStatus === "PAID" ? "PAID" : "UNPAID",
        });

        results.generated++;
        results.invoices.push({ orderId: order._id, orderNumber: order.orderNumber, invoiceNumber });
      } catch (err) {
        results.failed++;
        results.errors.push({ orderNumber: order.orderNumber, reason: err.message });
      }
    }

    await logAction(req, {
      action:      "OTHER",
      entity:      "Bill",
      description: `Bulk invoice generation: ${results.generated} generated, ${results.skipped} skipped, ${results.failed} failed`,
    });

    res.json({ success: true, message: `Generated ${results.generated} invoices`, results });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/bulk-invoice/pending
// Orders that don't have invoices yet
router.get("/pending", async (req, res) => {
  try {
    const { status = "DELIVERED" } = req.query;
    const billedOrderIds = await Bill.distinct("orderId");
    const orders = await Order.find({
      status,
      _id: { $nin: billedOrderIds },
    }).select("orderNumber buyer.name buyer.phone total status createdAt").lean();

    res.json({ success: true, orders, count: orders.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
