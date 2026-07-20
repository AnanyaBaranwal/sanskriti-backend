const express  = require("express");
const router   = express.Router();
const ExcelJS  = require("exceljs");

const Order   = require("../../models/Order.model");
const Bill    = require("../../models/Bill.model");
const Seller  = require("../../models/Seller.model");
const Product = require("../../models/Product.model");
const { protectStaff, requireModule } = require("../../middleware/staffAuth.middleware");
const { logAction } = require("../../utils/audit");

router.use(protectStaff, requireModule("export"));

// ── Helper: build workbook and stream it ─────────────────────
const streamExcel = async (res, filename, setupFn) => {
  const wb = new ExcelJS.Workbook();
  wb.creator   = "Sanskriti Admin";
  wb.created   = new Date();
  await setupFn(wb);

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
};

// ── Helper: stream CSV ────────────────────────────────────────
const streamCSV = (res, filename, headers, rows) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
  const lines = [headers.join(",")];
  rows.forEach(r => lines.push(r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")));
  res.send(lines.join("\n"));
};

// ── Header style helper ───────────────────────────────────────
const styleHeader = (ws, colCount) => {
  const row = ws.getRow(1);
  row.font      = { bold: true, color: { argb: "FF3D2B1F" } };
  row.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC9A84C" } };
  row.alignment = { vertical: "middle", horizontal: "center" };
  row.height    = 20;
  for (let i = 1; i <= colCount; i++) {
    ws.getColumn(i).width = 20;
    ws.getCell(1, i).border = {
      top: { style: "thin" }, left: { style: "thin" },
      bottom: { style: "thin" }, right: { style: "thin" },
    };
  }
};

// ── GET /api/admin/export/orders ─────────────────────────────
// ?from= &to= &status= &clientId= &format=xlsx|csv
router.get("/orders", async (req, res) => {
  try {
    const { from, to, status, format = "xlsx" } = req.query;
    const match = {};
    if (from || to) match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(from);
    if (to)   match.createdAt.$lte = new Date(to);
    if (status) match.status = status.toUpperCase();

    const orders = await Order.find(match).sort({ createdAt: -1 }).lean();

    await logAction(req, { action: "EXPORT", entity: "Order", description: `Exported ${orders.length} orders to ${format.toUpperCase()}` });

    if (format === "csv") {
      const headers = ["Order Number","Buyer Name","Buyer Phone","Status","Payment","Total","Items","Date"];
      const rows = orders.map(o => [
        o.orderNumber, o.buyer?.name, o.buyer?.phone,
        o.status, o.paymentStatus,
        o.total, o.items?.length || 0,
        new Date(o.createdAt).toLocaleDateString("en-IN"),
      ]);
      return streamCSV(res, `orders_${Date.now()}`, headers, rows);
    }

    await streamExcel(res, `orders_${Date.now()}`, async (wb) => {
      const ws = wb.addWorksheet("Orders");
      ws.columns = [
        { header: "Order Number",  key: "orderNumber" },
        { header: "Buyer Name",    key: "buyerName" },
        { header: "Buyer Phone",   key: "buyerPhone" },
        { header: "Buyer Email",   key: "buyerEmail" },
        { header: "City",          key: "city" },
        { header: "State",         key: "state" },
        { header: "Status",        key: "status" },
        { header: "Payment Status",key: "paymentStatus" },
        { header: "Payment Method",key: "paymentMethod" },
        { header: "Subtotal (₹)",  key: "subtotal" },
        { header: "Tax (₹)",       key: "tax" },
        { header: "Total (₹)",     key: "total" },
        { header: "Items Count",   key: "itemsCount" },
        { header: "Created At",    key: "createdAt" },
      ];
      styleHeader(ws, 14);

      orders.forEach(o => {
        ws.addRow({
          orderNumber:   o.orderNumber,
          buyerName:     o.buyer?.name,
          buyerPhone:    o.buyer?.phone,
          buyerEmail:    o.buyer?.email,
          city:          o.buyer?.address?.city,
          state:         o.buyer?.address?.state,
          status:        o.status,
          paymentStatus: o.paymentStatus,
          paymentMethod: o.paymentMethod,
          subtotal:      o.subtotal,
          tax:           o.taxAmount,
          total:         o.total,
          itemsCount:    o.items?.length || 0,
          createdAt:     new Date(o.createdAt).toLocaleDateString("en-IN"),
        });
      });
    });
  } catch (err) {
    console.error("[export/orders]", err);
    res.status(500).json({ success: false, message: "Export failed" });
  }
});

// ── GET /api/admin/export/bills ──────────────────────────────
// ?from= &to= &client= &product= &state= &paymentStatus= &format=
router.get("/bills", async (req, res) => {
  try {
    const { from, to, client, state, paymentStatus, format = "xlsx" } = req.query;
    const match = {};
    if (from || to) match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(from);
    if (to)   match.createdAt.$lte = new Date(to);
    if (client)        match["buyer.name"]           = { $regex: client, $options: "i" };
    if (state)         match["buyer.address.state"]  = { $regex: state,  $options: "i" };
    if (paymentStatus) match.paymentStatus           = paymentStatus.toUpperCase();

    const bills = await Bill.find(match).sort({ createdAt: -1 }).lean();

    await logAction(req, { action: "EXPORT", entity: "Bill", description: `Exported ${bills.length} bills` });

    if (format === "csv") {
      const headers = ["Invoice Number","Buyer","Phone","State","Subtotal","CGST","SGST","IGST","Total Tax","Grand Total","Payment Status","Date"];
      const rows = bills.map(b => [
        b.invoiceNumber, b.buyer?.name, b.buyer?.phone,
        b.buyer?.address?.state,
        b.subtotal, b.cgst, b.sgst, b.igst, b.totalTax, b.grandTotal,
        b.paymentStatus, new Date(b.createdAt).toLocaleDateString("en-IN"),
      ]);
      return streamCSV(res, `bills_${Date.now()}`, headers, rows);
    }

    await streamExcel(res, `bills_${Date.now()}`, async (wb) => {
      const ws = wb.addWorksheet("Bills");
      ws.columns = [
        { header: "Invoice Number", key: "invoiceNumber" },
        { header: "Buyer Name",     key: "buyerName" },
        { header: "Buyer Phone",    key: "buyerPhone" },
        { header: "Buyer Email",    key: "buyerEmail" },
        { header: "City",           key: "city" },
        { header: "State",          key: "state" },
        { header: "Subtotal (₹)",   key: "subtotal" },
        { header: "CGST (₹)",       key: "cgst" },
        { header: "SGST (₹)",       key: "sgst" },
        { header: "IGST (₹)",       key: "igst" },
        { header: "Total Tax (₹)",  key: "totalTax" },
        { header: "Grand Total (₹)",key: "grandTotal" },
        { header: "Payment Status", key: "paymentStatus" },
        { header: "Payment Method", key: "paymentMethod" },
        { header: "Date",           key: "createdAt" },
      ];
      styleHeader(ws, 15);

      bills.forEach(b => {
        ws.addRow({
          invoiceNumber: b.invoiceNumber,
          buyerName:     b.buyer?.name,
          buyerPhone:    b.buyer?.phone,
          buyerEmail:    b.buyer?.email,
          city:          b.buyer?.address?.city,
          state:         b.buyer?.address?.state,
          subtotal:      b.subtotal,
          cgst:          b.cgst,
          sgst:          b.sgst,
          igst:          b.igst,
          totalTax:      b.totalTax,
          grandTotal:    b.grandTotal,
          paymentStatus: b.paymentStatus,
          paymentMethod: b.paymentMethod,
          createdAt:     new Date(b.createdAt).toLocaleDateString("en-IN"),
        });
      });
    });
  } catch (err) {
    console.error("[export/bills]", err);
    res.status(500).json({ success: false, message: "Export failed" });
  }
});

// ── GET /api/admin/export/clients ────────────────────────────
router.get("/clients", async (req, res) => {
  try {
    const { format = "xlsx" } = req.query;
    const clients = await Seller.find({}).sort({ totalRevenue: -1 }).lean({ virtuals: true });

    await logAction(req, { action: "EXPORT", entity: "Seller", description: `Exported ${clients.length} clients` });

    if (format === "csv") {
      const headers = ["Name","Phone","Email","City","State","Total Orders","Total Revenue","Pending Payments","Return %","Last Order"];
      const rows = clients.map(c => [
        c.name, c.phone, c.email,
        c.address?.city, c.address?.state,
        c.totalOrders, c.totalRevenue, c.pendingPayments,
        c.returnPercent,
        c.lastOrderAt ? new Date(c.lastOrderAt).toLocaleDateString("en-IN") : "",
      ]);
      return streamCSV(res, `clients_${Date.now()}`, headers, rows);
    }

    await streamExcel(res, `clients_${Date.now()}`, async (wb) => {
      const ws = wb.addWorksheet("Clients");
      ws.columns = [
        { header: "Name",              key: "name" },
        { header: "Phone",             key: "phone" },
        { header: "Email",             key: "email" },
        { header: "City",              key: "city" },
        { header: "State",             key: "state" },
        { header: "Total Orders",      key: "totalOrders" },
        { header: "Total Revenue (₹)", key: "totalRevenue" },
        { header: "Pending (₹)",       key: "pendingPayments" },
        { header: "Return %",          key: "returnPercent" },
        { header: "Last Order",        key: "lastOrderAt" },
      ];
      styleHeader(ws, 10);
      clients.forEach(c => {
        ws.addRow({
          name:            c.name,
          phone:           c.phone,
          email:           c.email,
          city:            c.address?.city,
          state:           c.address?.state,
          totalOrders:     c.totalOrders,
          totalRevenue:    c.totalRevenue,
          pendingPayments: c.pendingPayments,
          returnPercent:   c.returnPercent,
          lastOrderAt:     c.lastOrderAt ? new Date(c.lastOrderAt).toLocaleDateString("en-IN") : "",
        });
      });
    });
  } catch (err) {
    console.error("[export/clients]", err);
    res.status(500).json({ success: false, message: "Export failed" });
  }
});

// ── GET /api/admin/export/inventory ──────────────────────────
router.get("/inventory", async (req, res) => {
  try {
    const { format = "xlsx" } = req.query;
    const products = await Product.find({ isActive: true })
      .select("-movementHistory")
      .sort({ name: 1 })
      .lean({ virtuals: true });

    await logAction(req, { action: "EXPORT", entity: "Product", description: `Exported ${products.length} products` });

    if (format === "csv") {
      const headers = ["Name","SKU","Category","Stock","Reorder Level","Status","Cost Price","Selling Price","Total Sold","Last Sold"];
      const rows = products.map(p => [
        p.name, p.sku, p.category, p.stock, p.reorderLevel, p.stockStatus,
        p.costPrice, p.sellingPrice, p.totalSold,
        p.lastSoldAt ? new Date(p.lastSoldAt).toLocaleDateString("en-IN") : "Never",
      ]);
      return streamCSV(res, `inventory_${Date.now()}`, headers, rows);
    }

    await streamExcel(res, `inventory_${Date.now()}`, async (wb) => {
      const ws = wb.addWorksheet("Inventory");
      ws.columns = [
        { header: "Name",            key: "name" },
        { header: "SKU",             key: "sku" },
        { header: "Category",        key: "category" },
        { header: "Stock",           key: "stock" },
        { header: "Reorder Level",   key: "reorderLevel" },
        { header: "Status",          key: "stockStatus" },
        { header: "Cost Price (₹)",  key: "costPrice" },
        { header: "Selling Price (₹)",key: "sellingPrice" },
        { header: "Total Sold",      key: "totalSold" },
        { header: "Last Sold",       key: "lastSoldAt" },
      ];
      styleHeader(ws, 10);
      products.forEach(p => {
        const row = ws.addRow({
          name:         p.name,
          sku:          p.sku,
          category:     p.category,
          stock:        p.stock,
          reorderLevel: p.reorderLevel,
          stockStatus:  p.stockStatus,
          costPrice:    p.costPrice,
          sellingPrice: p.sellingPrice,
          totalSold:    p.totalSold,
          lastSoldAt:   p.lastSoldAt ? new Date(p.lastSoldAt).toLocaleDateString("en-IN") : "Never",
        });
        // Color code stock status
        if (p.stockStatus === "OUT_OF_STOCK") row.getCell("stock").font = { color: { argb: "FFA32D2D" }, bold: true };
        else if (p.stockStatus === "LOW_STOCK") row.getCell("stock").font = { color: { argb: "FF854F0B" }, bold: true };
      });
    });
  } catch (err) {
    console.error("[export/inventory]", err);
    res.status(500).json({ success: false, message: "Export failed" });
  }
});

// ── GET /api/admin/export/gst-summary ────────────────────────
router.get("/gst-summary", async (req, res) => {
  try {
    const from   = req.query.from  ? new Date(req.query.from)  : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const to     = req.query.to    ? new Date(req.query.to)    : new Date();
    const format = req.query.format || "xlsx";

    const bills = await Bill.find({ createdAt: { $gte: from, $lte: to } })
      .select("invoiceNumber buyer.name buyer.address.state subtotal cgst sgst igst totalTax grandTotal paymentStatus isIntraState createdAt")
      .lean();

    if (format === "csv") {
      const headers = ["Invoice","Buyer","State","Type","Subtotal","CGST","SGST","IGST","Total Tax","Grand Total","Status","Date"];
      const rows = bills.map(b => [
        b.invoiceNumber, b.buyer?.name, b.buyer?.address?.state,
        b.isIntraState ? "Intra-State" : "Inter-State",
        b.subtotal, b.cgst, b.sgst, b.igst, b.totalTax, b.grandTotal,
        b.paymentStatus, new Date(b.createdAt).toLocaleDateString("en-IN"),
      ]);
      return streamCSV(res, `gst_summary_${Date.now()}`, headers, rows);
    }

    await streamExcel(res, `gst_summary_${Date.now()}`, async (wb) => {
      const ws = wb.addWorksheet("GST Summary");
      ws.columns = [
        { header: "Invoice No",     key: "invoiceNumber" },
        { header: "Buyer",          key: "buyerName" },
        { header: "State",          key: "state" },
        { header: "Type",           key: "type" },
        { header: "Subtotal (₹)",   key: "subtotal" },
        { header: "CGST (₹)",       key: "cgst" },
        { header: "SGST (₹)",       key: "sgst" },
        { header: "IGST (₹)",       key: "igst" },
        { header: "Total Tax (₹)",  key: "totalTax" },
        { header: "Grand Total (₹)",key: "grandTotal" },
        { header: "Status",         key: "paymentStatus" },
        { header: "Date",           key: "date" },
      ];
      styleHeader(ws, 12);
      bills.forEach(b => {
        ws.addRow({
          invoiceNumber: b.invoiceNumber,
          buyerName:     b.buyer?.name,
          state:         b.buyer?.address?.state,
          type:          b.isIntraState ? "Intra-State" : "Inter-State",
          subtotal:      b.subtotal,
          cgst:          b.cgst,
          sgst:          b.sgst,
          igst:          b.igst,
          totalTax:      b.totalTax,
          grandTotal:    b.grandTotal,
          paymentStatus: b.paymentStatus,
          date:          new Date(b.createdAt).toLocaleDateString("en-IN"),
        });
      });

      // Totals row
      const totalsRow = ws.addRow({
        invoiceNumber: "TOTAL",
        subtotal:  bills.reduce((s, b) => s + b.subtotal,  0),
        cgst:      bills.reduce((s, b) => s + b.cgst,      0),
        sgst:      bills.reduce((s, b) => s + b.sgst,      0),
        igst:      bills.reduce((s, b) => s + b.igst,      0),
        totalTax:  bills.reduce((s, b) => s + b.totalTax,  0),
        grandTotal:bills.reduce((s, b) => s + b.grandTotal,0),
      });
      totalsRow.font = { bold: true };
      totalsRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5E6C8" } };
    });
  } catch (err) {
    console.error("[export/gst-summary]", err);
    res.status(500).json({ success: false, message: "Export failed" });
  }
});

// ── GET /api/admin/export/outstanding-payments ───────────────
router.get("/outstanding-payments", async (req, res) => {
  try {
    const { format = "xlsx" } = req.query;
    const bills = await Bill.find({ paymentStatus: "UNPAID" }).sort({ createdAt: 1 }).lean();
    const now   = Date.now();

    if (format === "csv") {
      const headers = ["Invoice","Buyer","Phone","State","Grand Total","Overdue Days","Date"];
      const rows = bills.map(b => [
        b.invoiceNumber, b.buyer?.name, b.buyer?.phone,
        b.buyer?.address?.state, b.grandTotal,
        Math.floor((now - new Date(b.createdAt)) / (1000 * 60 * 60 * 24)),
        new Date(b.createdAt).toLocaleDateString("en-IN"),
      ]);
      return streamCSV(res, `outstanding_${Date.now()}`, headers, rows);
    }

    await streamExcel(res, `outstanding_${Date.now()}`, async (wb) => {
      const ws = wb.addWorksheet("Outstanding Payments");
      ws.columns = [
        { header: "Invoice No",     key: "invoiceNumber" },
        { header: "Buyer",          key: "buyerName" },
        { header: "Phone",          key: "phone" },
        { header: "State",          key: "state" },
        { header: "Amount Due (₹)", key: "grandTotal" },
        { header: "Overdue Days",   key: "overdueDays" },
        { header: "Invoice Date",   key: "date" },
      ];
      styleHeader(ws, 7);
      bills.forEach(b => {
        const overdueDays = Math.floor((now - new Date(b.createdAt)) / (1000 * 60 * 60 * 24));
        const row = ws.addRow({
          invoiceNumber: b.invoiceNumber,
          buyerName:     b.buyer?.name,
          phone:         b.buyer?.phone,
          state:         b.buyer?.address?.state,
          grandTotal:    b.grandTotal,
          overdueDays,
          date:          new Date(b.createdAt).toLocaleDateString("en-IN"),
        });
        if (overdueDays > 30) row.getCell("overdueDays").font = { color: { argb: "FFA32D2D" }, bold: true };
        else if (overdueDays > 7) row.getCell("overdueDays").font = { color: { argb: "FF854F0B" } };
      });
    });
  } catch (err) {
    console.error("[export/outstanding]", err);
    res.status(500).json({ success: false, message: "Export failed" });
  }
});

module.exports = router;
