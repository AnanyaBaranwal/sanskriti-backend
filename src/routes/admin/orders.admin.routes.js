const express  = require("express");
const router   = express.Router();
const ExcelJS  = require("exceljs");
const crypto   = require("crypto");
const multer   = require("multer");
const path     = require("path");
const mongoose = require("mongoose");

const Order       = require("../../models/Order.model");
const Client      = require("../../models/Client.model");
const Wallet      = require("../../models/Wallet.model");
const Transaction = require("../../models/Transaction.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");
const { logAction } = require("../../utils/audit");
const { findOrCreateClient, refreshClientStats } = require("../../utils/clientStats");

router.use(protect, restrictTo("admin"));

// ── Multer — memory storage for Excel uploads ─────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".xlsx", ".xls"].includes(ext)) return cb(null, true);
    cb(new Error("Only Excel files (.xlsx, .xls) are allowed"));
  },
});

// ── Helper: same totals logic as orderController ──────────────
const calculateTotals = (items, taxPercent = 0, discount = 0) => {
  const subtotal      = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const taxAmount     = Math.round((subtotal * taxPercent) / 100);
  const discountAmount = Number(discount) || 0;
  const total         = subtotal + taxAmount - discountAmount;
  return { subtotal, taxAmount, discountAmount, total };
};

// ── Helper: hash for duplicate detection ─────────────────────
// Two orders are duplicates if same buyer phone + same item names on same day
const orderHash = (phone, items, date) => {
  const itemKey = items.map(i => `${i.name}:${i.quantity}`).sort().join("|");
  const dayKey  = new Date(date).toISOString().slice(0, 10);
  return crypto.createHash("md5").update(`${phone}|${itemKey}|${dayKey}`).digest("hex");
};

// ── Helper: flag product-cost refund as pending admin approval ──
// Only flags — never touches the wallet. Wallet is credited only via
// PATCH /api/admin/refunds/:id/approve.
const flagRefundPending = (order) => {
  if (!order.walletDeducted || order.walletRefunded || order.refundStatus === "PENDING") return null;
  order.refundStatus         = "PENDING";
  order.refundEligibleAmount = order.subtotal;
  return `Refund of ₹${order.subtotal.toLocaleString("en-IN")} (product cost) flagged — pending admin approval`;
};

// ── GET /api/admin/orders ─────────────────────────────────────
// All orders across all sellers (admin view)
router.get("/", async (req, res) => {
  try {
    const {
      status, search, from, to, clientId,
      page = 1, limit = 20,
    } = req.query;

    const filter = {};
    if (status)   filter.status = status.toUpperCase();
    if (clientId) filter.clientId = clientId;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to)   filter.createdAt.$lte = new Date(to);
    }
    if (search) {
      filter.$or = [
        { orderNumber:   { $regex: search, $options: "i" } },
        { "buyer.name":  { $regex: search, $options: "i" } },
        { "buyer.phone": { $regex: search, $options: "i" } },
      ];
    }

    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit)),
      Order.countDocuments(filter),
    ]);

    res.json({ success: true, total, page: Number(page), pages: Math.ceil(total / limit), orders });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /api/admin/orders/bulk-upload ────────────────────────
// Excel columns expected (row 1 = header, row 2+ = data):
// buyer_name | buyer_phone | buyer_email | city | state | pincode |
// item1_name | item1_qty | item1_price |
// item2_name | item2_qty | item2_price |  (optional — up to 5 items)
// tax_percent | discount | payment_method | notes
router.post("/bulk-upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "Excel file is required" });
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(req.file.buffer);
  const ws = wb.worksheets[0];

  const results = { created: 0, skipped: 0, errors: [] };
  const createdOrders = [];

  // Collect existing hashes from today to detect duplicates against DB
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayOrders = await Order.find({ createdAt: { $gte: todayStart } })
    .select("buyer.phone items createdAt").lean();
  const existingHashes = new Set(
    todayOrders.map(o => orderHash(o.buyer.phone, o.items, o.createdAt))
  );

  // Track hashes within this upload batch to catch intra-batch duplicates
  const batchHashes = new Set();

  // Skip header row (row 1)
  const rows = [];
  ws.eachRow((row, rowNum) => { if (rowNum > 1) rows.push({ rowNum, row }); });

  for (const { rowNum, row } of rows) {
    try {
      const v = (col) => {
        const cell = row.getCell(col);
        return cell.text?.trim() || String(cell.value ?? "").trim();
      };

      const buyerName  = v(1);
      const buyerPhone = v(2);
      const buyerEmail = v(3);
      const city       = v(4);
      const state      = v(5);
      const pincode    = v(6);

      if (!buyerName || !buyerPhone) {
        results.errors.push({ row: rowNum, reason: "Missing buyer name or phone" });
        continue;
      }

      // Parse up to 5 items (columns 7–21, groups of 3)
      const items = [];
      for (let i = 0; i < 5; i++) {
        const base     = 7 + i * 3;
        const itemName = v(base);
        const itemQty  = parseFloat(v(base + 1));
        const itemPrice= parseFloat(v(base + 2));
        if (itemName && !isNaN(itemQty) && !isNaN(itemPrice) && itemQty > 0 && itemPrice >= 0) {
          items.push({ name: itemName, quantity: itemQty, price: itemPrice, total: itemQty * itemPrice });
        }
      }

      if (items.length === 0) {
        results.errors.push({ row: rowNum, reason: "No valid items found" });
        continue;
      }

      const taxPercent    = parseFloat(v(22)) || 0;
      const discount      = parseFloat(v(23)) || 0;
      const paymentMethod = v(24)?.toUpperCase() || "OTHER";
      const notes         = v(25) || "";

      // Duplicate check
      const hash = orderHash(buyerPhone, items, new Date());
      if (existingHashes.has(hash) || batchHashes.has(hash)) {
        results.skipped++;
        results.errors.push({ row: rowNum, reason: `Duplicate order for ${buyerName} (${buyerPhone})` });
        continue;
      }
      batchHashes.add(hash);

      const { subtotal, taxAmount, discountAmount, total } = calculateTotals(items, taxPercent, discount);

      const order = await Order.create({
        sellerId: req.seller.id,
        buyer: {
          name: buyerName, phone: buyerPhone, email: buyerEmail || null,
          address: { city, state, pincode },
        },
        items,
        subtotal, taxAmount, discountAmount, total,
        paymentMethod: ["WALLET","CASH","ONLINE","OTHER"].includes(paymentMethod) ? paymentMethod : "OTHER",
        notes,
        statusHistory: [{ status: "PENDING", note: "Created via bulk upload" }],
      });

      // Link to client
      const clientId = await findOrCreateClient({ sellerId: req.seller.id, buyer: order.buyer });
      if (clientId) {
        await Order.findByIdAndUpdate(order._id, { clientId });
        await refreshClientStats(clientId);
      }

      createdOrders.push(order._id);
      results.created++;
    } catch (err) {
      results.errors.push({ row: rowNum, reason: err.message });
    }
  }

  await logAction(req, {
    action:      "CREATE",
    entity:      "Order",
    description: `Bulk upload: ${results.created} created, ${results.skipped} skipped, ${results.errors.length} errors`,
  });

  res.json({
    success: true,
    message: `Bulk upload complete: ${results.created} orders created`,
    results,
    orderIds: createdOrders,
  });
});

// ── PATCH /api/admin/orders/bulk-status ──────────────────────
// Body: { orderIds: [], status: "SHIPPED", note: "..." }
// NOTE: bulk status changes do NOT trigger wallet debit/refund logic —
// use the single-order PATCH /:id/status endpoint for CONFIRMED/CANCELLED
// transitions that should move money.
router.patch("/bulk-status", async (req, res) => {
  try {
    const { orderIds, status, note } = req.body;

    if (!orderIds?.length) {
      return res.status(400).json({ success: false, message: "orderIds array is required" });
    }

    const validStatuses = ["PENDING","CONFIRMED","PROCESSING","PACKED","SHIPPED","DELIVERED","CANCELLED","RETURNED"];
    if (!validStatuses.includes(status?.toUpperCase())) {
      return res.status(400).json({ success: false, message: `Invalid status. Valid: ${validStatuses.join(", ")}` });
    }

    const newStatus = status.toUpperCase();
    const updated   = [];
    const failed    = [];

    for (const id of orderIds) {
      try {
        const order = await Order.findById(id);
        if (!order) { failed.push({ id, reason: "Not found" }); continue; }

        order.status = newStatus;
        order.statusHistory.push({
          status:    newStatus,
          note:      note || `Bulk status update to ${newStatus}`,
          changedAt: new Date(),
        });
        await order.save();
        updated.push(id);
      } catch (err) {
        failed.push({ id, reason: err.message });
      }
    }

    await logAction(req, {
      action:      "STATUS_CHANGE",
      entity:      "Order",
      description: `Bulk status update: ${updated.length} orders → ${newStatus}`,
    });

    res.json({
      success: true,
      message: `${updated.length} orders updated to ${newStatus}`,
      updated, failed,
    });
  } catch (err) {
    console.error("[bulk-status]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/admin/orders/:id/status ───────────────────────
// Single order status update (admin can update any seller's order).
// CONFIRMED (first time) → debits full order.total from the seller's wallet.
// CANCELLED → flags the product-cost (subtotal) as pending refund approval;
// nothing is credited until admin approves via PATCH /api/admin/refunds/:id/approve.
router.patch("/:id/status", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { status, note } = req.body;
    const validStatuses = ["PENDING","CONFIRMED","PROCESSING","PACKED","SHIPPED","DELIVERED","CANCELLED","RETURNED"];
    const newStatus = status?.toUpperCase();

    if (!validStatuses.includes(newStatus)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `Invalid status` });
    }

    const order = await Order.findById(req.params.id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const before = order.status;
    let walletMessage = null;

    // ── Deduct full order total from seller wallet the first time it's CONFIRMED ──
    if (newStatus === "CONFIRMED" && !order.walletDeducted) {
      const wallet = await Wallet.findOne({ sellerId: order.sellerId }).session(session);
      const currentBalance = wallet?.balance || 0;
      const amount = order.total;

      if (currentBalance < amount) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: `Cannot confirm order — seller wallet balance (₹${currentBalance.toLocaleString("en-IN")}) is less than the order amount (₹${amount.toLocaleString("en-IN")}). Ask the seller to add funds first.`,
        });
      }

      const balanceBefore = wallet.balance;
      const balanceAfter  = balanceBefore - amount;

      await Wallet.findByIdAndUpdate(
        wallet._id,
        { $inc: { balance: -amount, totalDebited: amount } },
        { session }
      );

      await Transaction.create([{
        walletId:      wallet._id,
        sellerId:      order.sellerId,
        type:          "DEBIT",
        amount,
        balanceBefore,
        balanceAfter,
        description:   `Order ${order.orderNumber} confirmed by admin`,
        reference:     `ORDER-${order.orderNumber}`,
        category:      "ORDER_PAYMENT",
        status:        "COMPLETED",
        metadata:      { orderId: order._id },
      }], { session });

      order.walletDeducted       = true;
      order.walletDeductedAmount = amount;
      walletMessage = `₹${amount.toLocaleString("en-IN")} deducted from seller wallet`;
    }

    // ── Flag product-cost refund as pending admin approval on cancellation ──
    if (newStatus === "CANCELLED") {
      const msg = flagRefundPending(order);
      if (msg) walletMessage = msg;
    }

    order.status = newStatus;
    order.statusHistory.push({ status: newStatus, note: note || walletMessage || `Status updated`, changedAt: new Date() });
    await order.save({ session });

    await session.commitTransaction();

    await logAction(req, {
      action:      "STATUS_CHANGE",
      entity:      "Order",
      entityId:    order._id,
      entityRef:   order.orderNumber,
      description: `Order ${order.orderNumber} status: ${before} → ${newStatus}${walletMessage ? ` (${walletMessage})` : ""}`,
      before:      { status: before },
      after:       { status: newStatus },
    });

    res.json({ success: true, order, walletMessage });
  } catch (err) {
    await session.abortTransaction();
    console.error("[order status update]", err);
    res.status(500).json({ success: false, message: err.message || "Server error" });
  } finally {
    session.endSession();
  }
});

// ── PATCH /api/admin/orders/:id/return ───────────────────────
// Mark order as RETURNED with reason. Flags the product-cost (subtotal)
// as pending seller-wallet refund — admin must approve via PATCH /api/admin/refunds/:id/approve.
router.patch("/:id/return", async (req, res) => {
  try {
    const { reason, refundAmount } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    if (!["DELIVERED", "SHIPPED"].includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: `Only DELIVERED or SHIPPED orders can be returned. Current: ${order.status}`,
      });
    }

    const before = order.status;
    order.status          = "RETURNED";
    order.paymentStatus   = refundAmount ? "REFUNDED" : order.paymentStatus;
    order.returnReason    = reason || "Return requested";
    order.returnedAt      = new Date();
    order.refundAmount    = refundAmount || 0; // buyer-side refund, unrelated to seller wallet

    const walletMessage = flagRefundPending(order);

    order.statusHistory.push({
      status:    "RETURNED",
      note:      `Return: ${reason || "No reason provided"}${refundAmount ? ` | Buyer refund: ₹${refundAmount}` : ""}${walletMessage ? ` | ${walletMessage}` : ""}`,
      changedAt: new Date(),
    });

    await order.save();

    // Update client stats
    if (order.clientId) await refreshClientStats(order.clientId);

    await logAction(req, {
      action:      "STATUS_CHANGE",
      entity:      "Order",
      entityId:    order._id,
      entityRef:   order.orderNumber,
      description: `Order ${order.orderNumber} marked as RETURNED. Reason: ${reason}${walletMessage ? ` (${walletMessage})` : ""}`,
      before:      { status: before },
      after:       { status: "RETURNED", returnReason: reason, refundAmount },
    });

    res.json({ success: true, message: "Order marked as returned", order, walletMessage });
  } catch (err) {
    console.error("[return]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/orders/returns ────────────────────────────
// List all returned orders
router.get("/returns", async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const [orders, total] = await Promise.all([
      Order.find({ status: "RETURNED" })
        .sort({ returnedAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      Order.countDocuments({ status: "RETURNED" }),
    ]);

    const totalRefunded = orders.reduce((s, o) => s + (o.refundAmount || 0), 0);

    res.json({ success: true, total, totalRefunded, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/orders/bulk-upload-template ───────────────
// Download the Excel template for bulk upload
router.get("/bulk-upload-template", async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Orders Template");

    ws.columns = [
      { header: "buyer_name *",    key: "buyer_name",     width: 20 },
      { header: "buyer_phone *",   key: "buyer_phone",    width: 15 },
      { header: "buyer_email",     key: "buyer_email",    width: 25 },
      { header: "city",            key: "city",           width: 15 },
      { header: "state",           key: "state",          width: 15 },
      { header: "pincode",         key: "pincode",        width: 12 },
      { header: "item1_name *",    key: "item1_name",     width: 20 },
      { header: "item1_qty *",     key: "item1_qty",      width: 12 },
      { header: "item1_price *",   key: "item1_price",    width: 12 },
      { header: "item2_name",      key: "item2_name",     width: 20 },
      { header: "item2_qty",       key: "item2_qty",      width: 12 },
      { header: "item2_price",     key: "item2_price",    width: 12 },
      { header: "item3_name",      key: "item3_name",     width: 20 },
      { header: "item3_qty",       key: "item3_qty",      width: 12 },
      { header: "item3_price",     key: "item3_price",    width: 12 },
      { header: "item4_name",      key: "item4_name",     width: 20 },
      { header: "item4_qty",       key: "item4_qty",      width: 12 },
      { header: "item4_price",     key: "item4_price",    width: 12 },
      { header: "item5_name",      key: "item5_name",     width: 20 },
      { header: "item5_qty",       key: "item5_qty",      width: 12 },
      { header: "item5_price",     key: "item5_price",    width: 12 },
      { header: "tax_percent",     key: "tax_percent",    width: 12 },
      { header: "discount",        key: "discount",       width: 12 },
      { header: "payment_method",  key: "payment_method", width: 16 },
      { header: "notes",           key: "notes",          width: 25 },
    ];

    // Style header row
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FF3D2B1F" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC9A84C" } };
    headerRow.height = 20;

    // Sample row
    ws.addRow([
      "Rahul Sharma", "9876543210", "rahul@example.com",
      "Mumbai", "Maharashtra", "400001",
      "Brass Ganesh Idol", 1, 5000,
      "Wooden Frame", 2, 1500,
      "", "", "", "", "", "", "", "", "",
      18, 0, "ONLINE", "Handle with care",
    ]);

    // Instructions sheet
    const infoWs = wb.addWorksheet("Instructions");
    infoWs.getCell("A1").value = "BULK ORDER UPLOAD — INSTRUCTIONS";
    infoWs.getCell("A1").font = { bold: true, size: 14 };
    [
      ["A3", "* = Required field"],
      ["A4", "buyer_name: Full name of the buyer"],
      ["A5", "buyer_phone: 10-digit Indian mobile number"],
      ["A6", "item1_name, item1_qty, item1_price: At least one item is required"],
      ["A7", "tax_percent: GST % (e.g. 18 for 18%)"],
      ["A8", "payment_method: CASH | ONLINE | WALLET | OTHER"],
      ["A9", "Duplicate orders (same phone + same items + same day) will be skipped"],
    ].forEach(([cell, text]) => { infoWs.getCell(cell).value = text; });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=\"bulk_order_template.xlsx\"");
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ success: false, message: "Template generation failed" });
  }
});

module.exports = router;
