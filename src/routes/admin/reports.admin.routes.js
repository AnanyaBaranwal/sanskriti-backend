const express = require("express");
const router  = express.Router();

const Order  = require("../../models/Order.model");
const Bill   = require("../../models/Bill.model");
const Seller = require("../../models/Seller.model");
const Product = require("../../models/Product.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");

router.use(protect, restrictTo("admin"));

// ── GET /api/admin/reports/dashboard ─────────────────────────
// Main dashboard stats card data
router.get("/dashboard", async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const [
      todayOrders,
      todayRevenue,
      pendingOrdersCount,
      pendingPaymentsData,
      lowStockCount,
      recentActivity,
      topClients,
      topProducts,
      weeklyRevenue,
    ] = await Promise.all([
      // Today's order count
      Order.countDocuments({ createdAt: { $gte: todayStart, $lte: todayEnd } }),

      // Today's revenue (paid bills today)
      Bill.aggregate([
        { $match: { paymentStatus: "PAID", createdAt: { $gte: todayStart, $lte: todayEnd } } },
        { $group: { _id: null, total: { $sum: "$grandTotal" } } },
      ]),

      // Pending orders count
      Order.countDocuments({ status: "PENDING" }),

      // Pending payments (unpaid bills total)
      Bill.aggregate([
        { $match: { paymentStatus: "UNPAID" } },
        { $group: { _id: null, total: { $sum: "$grandTotal" }, count: { $sum: 1 } } },
      ]),

      // Low stock products count
      Product.countDocuments({
        isActive: true,
        stock: { $gt: 0 },
        $expr: { $lte: ["$stock", "$reorderLevel"] },
      }),

      // Recent 10 audit log entries — use Orders as activity proxy if no audit log yet
      Order.find({})
        .sort({ updatedAt: -1 })
        .limit(10)
        .select("orderNumber status buyer.name total updatedAt")
        .lean(),

      // Top 5 clients by revenue
      Seller.find({})
        .sort({ totalRevenue: -1 })
        .limit(5)
        .select("name phone totalOrders totalRevenue pendingPayments")
        .lean(),

      // Top 5 products by totalSold
      Product.find({ isActive: true })
        .sort({ totalSold: -1 })
        .limit(5)
        .select("name sku totalSold stock sellingPrice")
        .lean(),

      // Last 7 days revenue for sparkline
      Bill.aggregate([
        {
          $match: {
            paymentStatus: "PAID",
            createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            revenue: { $sum: "$grandTotal" },
            orders:  { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    res.json({
      success: true,
      data: {
        todayOrders,
        todayRevenue:      todayRevenue[0]?.total       || 0,
        pendingOrders:     pendingOrdersCount,
        pendingPayments:   pendingPaymentsData[0]?.total || 0,
        pendingBillsCount: pendingPaymentsData[0]?.count || 0,
        lowStockCount,
        recentActivity,
        topClients,
        topProducts,
        weeklyRevenue,
      },
    });
  } catch (err) {
    console.error("[reports/dashboard]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/reports/sales?period=daily|weekly|monthly ─
router.get("/sales", async (req, res) => {
  try {
    const { period = "daily" } = req.query;

    let dateFormat, startDate;
    const now = new Date();

    if (period === "daily") {
      dateFormat = "%Y-%m-%d";
      startDate  = new Date(now.getFullYear(), now.getMonth(), 1); // this month
    } else if (period === "weekly") {
      dateFormat = "%Y-W%V";
      startDate  = new Date(now.getFullYear(), 0, 1); // this year
    } else {
      dateFormat = "%Y-%m";
      startDate  = new Date(now.getFullYear() - 1, now.getMonth(), 1); // last 12 months
    }

    const [salesData, orderCounts] = await Promise.all([
      Bill.aggregate([
        { $match: { paymentStatus: "PAID", createdAt: { $gte: startDate } } },
        {
          $group: {
            _id:     { $dateToString: { format: dateFormat, date: "$createdAt" } },
            revenue: { $sum: "$grandTotal" },
            tax:     { $sum: "$totalTax" },
            count:   { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      Order.aggregate([
        { $match: { createdAt: { $gte: startDate } } },
        {
          $group: {
            _id:    { $dateToString: { format: dateFormat, date: "$createdAt" } },
            orders: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    // Merge revenue + order counts by date key
    const orderMap = {};
    orderCounts.forEach(o => { orderMap[o._id] = o.orders; });

    const merged = salesData.map(d => ({
      date:    d._id,
      revenue: d.revenue,
      tax:     d.tax,
      bills:   d.count,
      orders:  orderMap[d._id] || 0,
    }));

    // Growth vs previous period
    const totalRevenue = merged.reduce((s, d) => s + d.revenue, 0);
    const totalOrders  = merged.reduce((s, d) => s + d.orders, 0);

    res.json({ success: true, period, data: merged, totals: { revenue: totalRevenue, orders: totalOrders } });
  } catch (err) {
    console.error("[reports/sales]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/reports/top-products?limit=10&from=&to= ───
router.get("/top-products", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const from  = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to    = req.query.to   ? new Date(req.query.to)   : new Date();

    // Aggregate from bills items in date range
    const topProducts = await Bill.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      { $unwind: "$items" },
      {
        $group: {
          _id:         "$items.name",
          totalQty:    { $sum: "$items.quantity" },
          totalRevenue:{ $sum: "$items.total" },
          orderCount:  { $sum: 1 },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          name:         "$_id",
          totalQty:     1,
          totalRevenue: 1,
          orderCount:   1,
        },
      },
    ]);

    res.json({ success: true, from, to, data: topProducts });
  } catch (err) {
    console.error("[reports/top-products]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/reports/top-clients?limit=10 ──────────────
router.get("/top-clients", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const from  = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to    = req.query.to   ? new Date(req.query.to)   : new Date();

    const topClients = await Bill.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id:         "$buyer.phone",
          name:        { $first: "$buyer.name" },
          email:       { $first: "$buyer.email" },
          totalRevenue:{ $sum: "$grandTotal" },
          orderCount:  { $sum: 1 },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          phone:        "$_id",
          name:         1,
          email:        1,
          totalRevenue: 1,
          orderCount:   1,
        },
      },
    ]);

    res.json({ success: true, from, to, data: topClients });
  } catch (err) {
    console.error("[reports/top-clients]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/reports/gst-summary?from=&to=&state= ──────
router.get("/gst-summary", async (req, res) => {
  try {
    const from  = req.query.from  ? new Date(req.query.from)  : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const to    = req.query.to    ? new Date(req.query.to)    : new Date();
    const state = req.query.state || null;

    const matchStage = { createdAt: { $gte: from, $lte: to } };
    if (state) matchStage["buyer.address.state"] = { $regex: state, $options: "i" };

    const summary = await Bill.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id:          "$isIntraState",
          totalCGST:    { $sum: "$cgst" },
          totalSGST:    { $sum: "$sgst" },
          totalIGST:    { $sum: "$igst" },
          totalTax:     { $sum: "$totalTax" },
          totalRevenue: { $sum: "$grandTotal" },
          invoiceCount: { $sum: 1 },
        },
      },
    ]);

    // By state breakdown
    const byState = await Bill.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id:         "$buyer.address.state",
          totalTax:    { $sum: "$totalTax" },
          totalCGST:   { $sum: "$cgst" },
          totalSGST:   { $sum: "$sgst" },
          totalIGST:   { $sum: "$igst" },
          invoiceCount:{ $sum: 1 },
          revenue:     { $sum: "$grandTotal" },
        },
      },
      { $sort: { revenue: -1 } },
    ]);

    const totals = await Bill.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id:          null,
          totalCGST:    { $sum: "$cgst" },
          totalSGST:    { $sum: "$sgst" },
          totalIGST:    { $sum: "$igst" },
          totalTax:     { $sum: "$totalTax" },
          totalRevenue: { $sum: "$grandTotal" },
          invoiceCount: { $sum: 1 },
        },
      },
    ]);

    res.json({
      success: true, from, to,
      totals:   totals[0]  || {},
      byType:   summary,
      byState,
    });
  } catch (err) {
    console.error("[reports/gst-summary]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/reports/outstanding-payments ───────────────
router.get("/outstanding-payments", async (req, res) => {
  try {
    const bills = await Bill.find({ paymentStatus: "UNPAID" })
      .sort({ createdAt: 1 }) // oldest first = most overdue
      .select("invoiceNumber buyer grandTotal createdAt seller.businessName")
      .lean();

    // Add overdue days
    const now = Date.now();
    const enriched = bills.map(b => ({
      ...b,
      overdueDays: Math.floor((now - new Date(b.createdAt)) / (1000 * 60 * 60 * 24)),
    }));

    const totalOutstanding = bills.reduce((s, b) => s + b.grandTotal, 0);

    res.json({
      success: true,
      totalOutstanding,
      count: bills.length,
      bills: enriched,
    });
  } catch (err) {
    console.error("[reports/outstanding-payments]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/reports/client-revenue/:clientId ──────────
router.get("/client-revenue/:clientId", async (req, res) => {
  try {
    const client = await Seller.findById(req.params.clientId).lean({ virtuals: true });
    if (!client) return res.status(404).json({ success: false, message: "Seller not found" });

    // Monthly revenue for this client
    const monthlyRevenue = await Bill.aggregate([
      { $match: { "buyer.phone": client.phone } },
      {
        $group: {
          _id:     { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
          revenue: { $sum: "$grandTotal" },
          count:   { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      success: true,
      client,
      monthlyRevenue,
    });
  } catch (err) {
    console.error("[reports/client-revenue]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/reports/sales-trend?months=6 ──────────────
// Growth % vs previous period for trend analysis
router.get("/sales-trend", async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 6;
    const from   = new Date();
    from.setMonth(from.getMonth() - months);
    from.setDate(1);
    from.setHours(0, 0, 0, 0);

    const data = await Bill.aggregate([
      { $match: { createdAt: { $gte: from } } },
      {
        $group: {
          _id:     { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
          revenue: { $sum: "$grandTotal" },
          tax:     { $sum: "$totalTax" },
          count:   { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Add growth % vs previous month
    const enriched = data.map((d, i) => {
      const prev   = data[i - 1];
      const growth = prev && prev.revenue > 0
        ? Math.round(((d.revenue - prev.revenue) / prev.revenue) * 100)
        : null;
      return { ...d, growthPercent: growth };
    });

    res.json({ success: true, months, data: enriched });
  } catch (err) {
    console.error("[reports/sales-trend]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/reports/monthly-profit?year= ──────────────
router.get("/monthly-profit", async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const from = new Date(year, 0, 1);
    const to   = new Date(year, 11, 31, 23, 59, 59);

    const revenue = await Bill.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, paymentStatus: "PAID" } },
      {
        $group: {
          _id:     { $month: "$createdAt" },
          revenue: { $sum: "$grandTotal" },
          tax:     { $sum: "$totalTax" },
          count:   { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const filled = months.map((name, i) => {
      const found = revenue.find(r => r._id === i + 1);
      return { month: name, revenue: found?.revenue || 0, tax: found?.tax || 0, invoices: found?.count || 0 };
    });

    res.json({ success: true, year, data: filled });
  } catch (err) {
    console.error("[reports/monthly-profit]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
