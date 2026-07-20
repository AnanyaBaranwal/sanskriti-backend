const express    = require("express");
const router     = express.Router();
const Anthropic  = require("@anthropic-ai/sdk");

const Order   = require("../../models/Order.model");
const Bill    = require("../../models/Bill.model");
const Seller  = require("../../models/Seller.model");
const Product = require("../../models/Product.model");
const { protectStaff, restrictStaffTo } = require("../../middleware/staffAuth.middleware");

router.use(protectStaff, restrictStaffTo("admin"));

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── GET /api/admin/ai/monthly-summary?month=&year= ────────────
router.get("/monthly-summary", async (req, res) => {
  try {
    const now   = new Date();
    const month = parseInt(req.query.month) || now.getMonth() + 1;
    const year  = parseInt(req.query.year)  || now.getFullYear();

    const from = new Date(year, month - 1, 1);
    const to   = new Date(year, month, 0, 23, 59, 59);
    const prevFrom = new Date(year, month - 2, 1);
    const prevTo   = new Date(year, month - 1, 0, 23, 59, 59);

    const [orders, bills, prevBills, topProducts, topClients] = await Promise.all([
      Order.find({ createdAt: { $gte: from, $lte: to } }).lean(),
      Bill.find({ createdAt: { $gte: from, $lte: to }, paymentStatus: "PAID" }).lean(),
      Bill.find({ createdAt: { $gte: prevFrom, $lte: prevTo }, paymentStatus: "PAID" }).lean(),
      Bill.aggregate([
        { $match: { createdAt: { $gte: from, $lte: to } } },
        { $unwind: "$items" },
        { $group: { _id: "$items.name", revenue: { $sum: "$items.total" }, qty: { $sum: "$items.quantity" } } },
        { $sort: { revenue: -1 } },
        { $limit: 5 },
      ]),
      Bill.aggregate([
        { $match: { createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: "$buyer.phone", name: { $first: "$buyer.name" }, revenue: { $sum: "$grandTotal" }, count: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
        { $limit: 5 },
      ]),
    ]);

    const revenue     = bills.reduce((s, b) => s + b.grandTotal, 0);
    const prevRevenue = prevBills.reduce((s, b) => s + b.grandTotal, 0);
    const growth      = prevRevenue > 0 ? Math.round(((revenue - prevRevenue) / prevRevenue) * 100) : null;
    const returned    = orders.filter(o => o.status === "RETURNED").length;
    const unpaidBills = await Bill.countDocuments({ createdAt: { $gte: from, $lte: to }, paymentStatus: "UNPAID" });

    const monthName = from.toLocaleString("en-IN", { month: "long", year: "numeric" });

    const dataContext = `
Business Monthly Data for ${monthName}:
- Total Orders: ${orders.length}
- Delivered: ${orders.filter(o => o.status === "DELIVERED").length}
- Returned: ${returned}
- Revenue Collected: ₹${revenue.toLocaleString("en-IN")}
- Previous Month Revenue: ₹${prevRevenue.toLocaleString("en-IN")}
- Growth vs Last Month: ${growth !== null ? `${growth > 0 ? "+" : ""}${growth}%` : "N/A (first month)"}
- Unpaid Invoices: ${unpaidBills}
- Top 5 Products by Revenue: ${topProducts.map((p, i) => `${i + 1}. ${p._id} (₹${p.revenue.toLocaleString("en-IN")}, ${p.qty} units)`).join("; ")}
- Top 5 Clients by Revenue: ${topClients.map((c, i) => `${i + 1}. ${c.name} (₹${c.revenue.toLocaleString("en-IN")}, ${c.count} orders)`).join("; ")}
    `.trim();

    const message = await anthropic.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `You are a business analyst for Sanskriti, an Indian antique marketplace. Based on this data, write a concise 3-paragraph monthly business summary in a professional but friendly tone. Focus on: (1) overall performance and key numbers, (2) what went well and what needs attention, (3) specific actionable recommendations for next month. Keep it under 250 words. Use Indian currency format (₹). Data:\n\n${dataContext}`,
      }],
    });

    const summary = message.content[0].type === "text" ? message.content[0].text : "";

    res.json({
      success: true,
      month: monthName,
      data: { revenue, prevRevenue, growth, totalOrders: orders.length, returned, unpaidBills, topProducts, topClients },
      summary,
    });
  } catch (err) {
    console.error("[ai/monthly-summary]", err);
    res.status(500).json({ success: false, message: err.message || "AI summary failed" });
  }
});

// ── POST /api/admin/ai/nl-search ─────────────────────────────
// Body: { query: "show unpaid invoices from last month" }
router.post("/nl-search", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query?.trim()) return res.status(400).json({ success: false, message: "Query is required" });

    const schemaContext = `
MongoDB Collections:
1. orders: { orderNumber, buyer:{name,phone,email,address:{city,state}}, items:[{name,quantity,price,total}], subtotal, taxAmount, total, status (PENDING/CONFIRMED/PROCESSING/PACKED/SHIPPED/DELIVERED/CANCELLED/RETURNED), paymentStatus (UNPAID/PAID/REFUNDED), createdAt, clientId }
2. bills: { invoiceNumber, buyer:{name,phone,email,address:{city,state}}, items:[{name,quantity,price,total}], subtotal, cgst, sgst, igst, totalTax, grandTotal, paymentStatus (PAID/UNPAID/PARTIAL), createdAt }
3. clients: { name, phone, email, address:{city,state}, totalOrders, totalRevenue, pendingPayments, returnedOrders, lastOrderAt }
4. products: { name, sku, category, stock, reorderLevel, costPrice, sellingPrice, totalSold, lastSoldAt, isActive }

Today's date: ${new Date().toISOString().slice(0, 10)}
    `.trim();

    const aiRes = await anthropic.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `You are a MongoDB query generator. Given a natural language search query about a business database, return ONLY a valid JSON object with these fields:
{
  "collection": "orders|bills|clients|products",
  "filter": { /* MongoDB filter object */ },
  "sort": { /* MongoDB sort object or null */ },
  "limit": number (max 50),
  "explanation": "brief human-readable explanation of what this query does"
}

Return ONLY the JSON, no markdown, no explanation outside the JSON.

Schema:
${schemaContext}

User query: "${query}"`,
      }],
    });

    const rawText = aiRes.content[0].type === "text" ? aiRes.content[0].text.trim() : "{}";

    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
    } catch {
      return res.status(422).json({ success: false, message: "Could not parse query. Try rephrasing.", raw: rawText });
    }

    const { collection, filter = {}, sort = null, limit = 20, explanation } = parsed;
    const validCollections = { orders: Order, bills: Bill, clients: Seller, products: Product };

    if (!validCollections[collection]) {
      return res.status(422).json({ success: false, message: `Unknown collection: ${collection}` });
    }

    const Model = validCollections[collection];
    let queryBuilder = Model.find(filter).limit(Math.min(limit, 50));
    if (sort) queryBuilder = queryBuilder.sort(sort);

    const results = await queryBuilder.lean();

    res.json({
      success: true,
      query,
      explanation,
      collection,
      count: results.length,
      results,
    });
  } catch (err) {
    console.error("[ai/nl-search]", err);
    res.status(500).json({ success: false, message: err.message || "AI search failed" });
  }
});

// ── GET /api/admin/ai/forecast ────────────────────────────────
router.get("/forecast", async (req, res) => {
  try {
    const days90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const [weeklyRevenue, lowStock, topProducts] = await Promise.all([
      Bill.aggregate([
        { $match: { createdAt: { $gte: days90 }, paymentStatus: "PAID" } },
        {
          $group: {
            _id:     { $dateToString: { format: "%Y-%W", date: "$createdAt" } },
            revenue: { $sum: "$grandTotal" },
            orders:  { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Product.find({ isActive: true, $expr: { $lte: ["$stock", "$reorderLevel"] } })
        .select("name sku stock reorderLevel totalSold")
        .lean(),
      Bill.aggregate([
        { $match: { createdAt: { $gte: days90 } } },
        { $unwind: "$items" },
        { $group: { _id: "$items.name", totalQty: { $sum: "$items.quantity" }, revenue: { $sum: "$items.total" } } },
        { $sort: { totalQty: -1 } },
        { $limit: 10 },
      ]),
    ]);

    const dataContext = `
Last 90 days business data for Sanskriti antique marketplace:

Weekly Revenue Trend (last 13 weeks):
${weeklyRevenue.map(w => `Week ${w._id}: ₹${w.revenue.toLocaleString("en-IN")} (${w.orders} orders)`).join("\n")}

Products needing restock (stock at or below reorder level):
${lowStock.map(p => `- ${p.name} (SKU: ${p.sku || "N/A"}): stock=${p.stock}, reorder_at=${p.reorderLevel}, sold_total=${p.totalSold}`).join("\n") || "None currently"}

Top 10 products by quantity sold in last 90 days:
${topProducts.map((p, i) => `${i + 1}. ${p._id}: ${p.totalQty} units, ₹${p.revenue.toLocaleString("en-IN")}`).join("\n")}
    `.trim();

    const message = await anthropic.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `You are a business forecasting analyst for Sanskriti, an Indian antique marketplace. Based on the last 90 days of data, provide:

1. A 4-week revenue forecast (predict revenue for each of the next 4 weeks based on trends)
2. Top 5 restock recommendations with suggested order quantities

Return ONLY a JSON object in this exact format (no markdown, no explanation):
{
  "revenueForecast": [
    { "week": "Week 1", "predicted": number, "confidence": "high|medium|low" },
    { "week": "Week 2", "predicted": number, "confidence": "high|medium|low" },
    { "week": "Week 3", "predicted": number, "confidence": "high|medium|low" },
    { "week": "Week 4", "predicted": number, "confidence": "high|medium|low" }
  ],
  "restockSuggestions": [
    { "name": string, "currentStock": number, "suggestedOrder": number, "reason": string }
  ],
  "insight": "one sentence business insight"
}

Data:
${dataContext}`,
      }],
    });

    const rawText = message.content[0].type === "text" ? message.content[0].text.trim() : "{}";

    let forecast;
    try {
      forecast = JSON.parse(rawText.replace(/```json|```/g, "").trim());
    } catch {
      return res.status(422).json({ success: false, message: "Could not parse forecast", raw: rawText });
    }

    res.json({ success: true, forecast, weeklyRevenue });
  } catch (err) {
    console.error("[ai/forecast]", err);
    res.status(500).json({ success: false, message: err.message || "Forecast failed" });
  }
});

module.exports = router;
