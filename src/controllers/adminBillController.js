const fs      = require("fs");
const path    = require("path");
const ExcelJS = require("exceljs");
const Bill    = require("../models/Bill.model");
const Seller  = require("../models/Seller.model");
const Order   = require("../models/Order.model");
const { generateInvoicePDF, ensureBillsDir } = require("../utils/invoicePdf");
const { logAction } = require("../utils/audit");

// ── GET /api/admin/bills/stats ──────────────────────────────────
exports.getBillingStats = async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalAgg, monthAgg, totalBills, monthBills] = await Promise.all([
      Bill.aggregate([{ $group: { _id: null, revenue: { $sum: "$grandTotal" } } }]),
      Bill.aggregate([
        { $match: { createdAt: { $gte: startOfMonth } } },
        { $group: { _id: null, revenue: { $sum: "$grandTotal" } } },
      ]),
      Bill.countDocuments({}),
      Bill.countDocuments({ createdAt: { $gte: startOfMonth } }),
    ]);

    res.json({
      success: true,
      stats: {
        totalRevenue: totalAgg[0]?.revenue || 0,
        totalBills,
        monthRevenue: monthAgg[0]?.revenue || 0,
        monthBills,
      },
    });
  } catch (err) {
    console.error("Get billing stats error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.listSellers = async (req, res) => {
  try {
    const clients = await Seller.find({ role: "seller" })
      .select("name company email phone gstNumber address sellerId")
      .sort({ company: 1, name: 1 })
      .lean();
    res.json({ success: true, sellers: clients });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.listOrdersForBilling = async (req, res) => {
  try {
    const { search = "", page = 1, limit = 20 } = req.query;

    const filter = {};
    if (search) {
      filter.$or = [
        { orderNumber: { $regex: search, $options: "i" } },
        { "buyer.name": { $regex: search, $options: "i" } },
      ];
    }

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate("sellerId", "name company email phone")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .select("orderNumber buyer items total costTotal createdAt sellerId status")
        .lean(),
      Order.countDocuments(filter),
    ]);

    const orderIds = orders.map((o) => o._id);
    const bills = await Bill.find({ orderId: { $in: orderIds } })
      .select("orderId invoiceNumber pdfUrl grandTotal updatedAt")
      .lean();

    const billMap = {};
    bills.forEach((b) => { billMap[String(b.orderId)] = b; });

    const ordersWithBillStatus = orders.map((o) => ({
      ...o,
      bill: billMap[String(o._id)] || null,
    }));

    res.json({
      success: true,
      orders: ordersWithBillStatus,
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("List orders for billing error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getOrderForBilling = async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId).populate("sellerId", "name company email phone");
    if (!order) {
      return res.status(404).json({ success: false, message: "No order found with that ID" });
    }
    const existingBill = await Bill.findOne({ orderId: order._id }).select("invoiceNumber");
    res.json({ success: true, order, existingBill: existingBill || null });
  } catch (err) {
    res.status(400).json({ success: false, message: "Invalid order ID" });
  }
};

exports.createManualBill = async (req, res) => {
  try {
    const {
      sellerId, product, sku, quantity = 1, price,
      shippingCharge = 0, packagingCharge = 0, taxPercent = 18,
      paymentMode = "Razorpay Wallet",
      transactionId, invoiceNumber, date,
    } = req.body;

    if (!sellerId || !product || price === undefined || price === null) {
      return res.status(400).json({ success:false, message:"Company, Product and Price are required" });
    }

    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ success:false, message:"Company not found" });

    if (transactionId) {
      const dupe = await Bill.findOne({ transactionId });
      if (dupe) return res.status(400).json({ success:false, message:"Transaction ID already exists" });
    }
    if (invoiceNumber) {
      const dupe = await Bill.findOne({ invoiceNumber });
      if (dupe) return res.status(400).json({ success:false, message:"Invoice number already exists" });
    }

    const qty       = Number(quantity) || 1;
    const unitPrice  = Number(price);
    const itemAmount = qty * unitPrice;
    const subtotal   = itemAmount;
    const ship       = Number(shippingCharge) || 0;
    const pack       = Number(packagingCharge) || 0;
    const taxPct     = Number(taxPercent) || 0;
    const taxAmount  = Math.round(((subtotal + ship + pack) * taxPct) / 100);
    const grandTotal = subtotal + ship + pack + taxAmount;

    const bill = new Bill({
      sellerId,
      transactionId: transactionId || undefined,
      invoiceNumber: invoiceNumber || undefined,
      invoiceDate: date ? new Date(date) : new Date(),
      buyer: {
        name:      seller.company || seller.name,
        email:     seller.email,
        phone:     seller.phone,
        gstNumber: seller.gstNumber,
        state:     seller.address?.state,
        pincode:   seller.address?.pincode,
        address:   [seller.address?.street, seller.address?.city, seller.address?.state]
                      .filter(Boolean).join(", "),
      },
      items: [{ name: product, sku: sku || "", quantity: qty, price: unitPrice, amount: itemAmount }],
      subtotal,
      shippingCharge: ship,
      packagingCharge: pack,
      taxPercent: taxPct,
      taxAmount,
      grandTotal,
      currency: "INR",
      paymentMode,
      paymentStatus: "UNPAID",
    });

    await bill.save();

    let pdfBytes;
    try {
      pdfBytes = await generateInvoicePDF(bill);
    } catch (pdfErr) {
      await Bill.findByIdAndDelete(bill._id);
      console.error("Generate invoice PDF error (manual):", pdfErr);
      return res.status(500).json({
        success: false,
        message: `Bill was not created — invoice PDF generation failed: ${pdfErr.message}`,
      });
    }

    const billsDir = ensureBillsDir();
    const filename = `${bill.invoiceNumber}.pdf`;
    fs.writeFileSync(path.join(billsDir, filename), pdfBytes);
    bill.pdfUrl = `/uploads/bills/${filename}`;
    await bill.save();

    await logAction(req, {
      action: "CREATE",
      entity: "Bill",
      entityId: bill._id,
      entityRef: bill.invoiceNumber,
      description: `Invoice ${bill.invoiceNumber} generated for ${bill.buyer.name}`,
    });

    res.status(201).json({ success:true, message:"Invoice generated successfully", bill });
  } catch (err) {
    console.error("Create manual bill error:", err);
    res.status(500).json({ success:false, message: err.message });
  }
};

exports.createBillFromOrder = async (req, res) => {
  try {
    const {
      orderId, shippingCharge = 0, packagingCharge = 0, taxPercent,
      paymentMode = "Razorpay Wallet", transactionId, invoiceNumber, date,
    } = req.body;

    if (!orderId) {
      return res.status(400).json({ success:false, message:"orderId is required" });
    }
    if (taxPercent === undefined || taxPercent === null || taxPercent === "") {
      return res.status(400).json({ success:false, message:"Tax % is required" });
    }

    const order = await Order.findById(orderId).populate("sellerId");
    if (!order) return res.status(404).json({ success:false, message:"Order not found" });
    if (!order.sellerId) return res.status(400).json({ success:false, message:"This order has no linked seller — cannot bill it" });

    const existing = await Bill.findOne({ orderId });
    if (existing) {
      return res.status(400).json({ success:false, message:`This order already has an invoice (${existing.invoiceNumber})` });
    }

    if (transactionId) {
      const dupe = await Bill.findOne({ transactionId });
      if (dupe) return res.status(400).json({ success:false, message:"Transaction ID already exists" });
    }
    if (invoiceNumber) {
      const dupe = await Bill.findOne({ invoiceNumber });
      if (dupe) return res.status(400).json({ success:false, message:"Invoice number already exists" });
    }

    if (!order.items?.length) {
      return res.status(400).json({ success:false, message:"This order has no items to bill" });
    }

    const seller = order.sellerId;

    const billItems = order.items.map((it) => {
      const qty = Number(it.quantity) || 1;
      const unitPrice = it.costPrice > 0 ? it.costPrice : (it.price || 0);
      return {
        name: it.name,
        sku: it.galleryProductId ? String(it.galleryProductId) : "",
        quantity: qty,
        price: unitPrice,
        amount: unitPrice * qty,
      };
    });

    const subtotal   = billItems.reduce((sum, i) => sum + i.amount, 0);
    const ship       = Number(shippingCharge) || 0;
    const pack       = Number(packagingCharge) || 0;
    const taxPct     = Number(taxPercent) || 0;
    const taxAmount  = Math.round(((subtotal + ship + pack) * taxPct) / 100);
    const grandTotal = subtotal + ship + pack + taxAmount;

    const bill = new Bill({
      sellerId: seller._id,
      orderId: order._id,
      transactionId: transactionId || undefined,
      invoiceNumber: invoiceNumber || undefined,
      invoiceDate: date ? new Date(date) : new Date(),
      buyer: {
        name:      seller.company || seller.name,
        email:     seller.email,
        phone:     seller.phone,
        gstNumber: seller.gstNumber,
        state:     seller.address?.state,
        pincode:   seller.address?.pincode,
        address:   [seller.address?.street, seller.address?.city, seller.address?.state]
                      .filter(Boolean).join(", "),
      },
      items: billItems,
      subtotal,
      shippingCharge: ship,
      packagingCharge: pack,
      taxPercent: taxPct,
      taxAmount,
      grandTotal,
      currency: "INR",
      paymentMode,
      paymentStatus: "UNPAID",
    });

    await bill.save();

    let pdfBytes;
    try {
      pdfBytes = await generateInvoicePDF(bill);
    } catch (pdfErr) {
      await Bill.findByIdAndDelete(bill._id);
      console.error("Generate invoice PDF error (order):", pdfErr);
      return res.status(500).json({
        success: false,
        message: `Bill was not created — invoice PDF generation failed: ${pdfErr.message}`,
      });
    }

    const billsDir = ensureBillsDir();
    const filename = `${bill.invoiceNumber}.pdf`;
    fs.writeFileSync(path.join(billsDir, filename), pdfBytes);
    bill.pdfUrl = `/uploads/bills/${filename}`;
    await bill.save();

    await logAction(req, {
      action: "CREATE",
      entity: "Bill",
      entityId: bill._id,
      entityRef: bill.invoiceNumber,
      description: `Invoice ${bill.invoiceNumber} generated for ${bill.buyer.name} from order ${order.orderNumber}`,
    });

    res.status(201).json({ success:true, message:"Invoice generated successfully", bill });
  } catch (err) {
    console.error("Create bill from order error:", err);
    res.status(500).json({ success:false, message: err.message });
  }
};

exports.getAllBills = async (req, res) => {
  try {
    const { sellerId, page = 1, limit = 20, search = "" } = req.query;
    const filter = {};
    if (sellerId) filter.sellerId = sellerId;
    if (search) {
      filter.$or = [
        { invoiceNumber: { $regex: search, $options: "i" } },
        { transactionId: { $regex: search, $options: "i" } },
        { "items.name":   { $regex: search, $options: "i" } },
        { "buyer.name":   { $regex: search, $options: "i" } },
      ];
    }
    const [bills, total] = await Promise.all([
      Bill.find(filter).sort({ createdAt: -1 }).skip((page-1)*limit).limit(Number(limit)),
      Bill.countDocuments(filter),
    ]);
    res.json({
      success: true,
      bills,
      stats: {
        total: await Bill.countDocuments({}),
        today: await Bill.countDocuments({ createdAt: { $gte: new Date(new Date().setHours(0,0,0,0)) } }),
        thisMonth: await Bill.countDocuments({ createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } }),
      },
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total/limit) },
    });
  } catch (err) {
    res.status(500).json({ success:false, message: err.message });
  }
};

exports.getBillByIdAdmin = async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) return res.status(404).json({ success:false, message:"Bill not found" });
    res.json({ success:true, bill });
  } catch (err) {
    res.status(500).json({ success:false, message: err.message });
  }
};

// ── GET /api/admin/bills/:id/pdf ────────────────────────────────
// Regenerates the invoice PDF live from the Bill document in MongoDB and
// streams it back directly — deliberately does NOT read from disk.
//
// Why: uploads/ is written to at runtime but is not part of the git repo,
// so on hosts that redeploy via a fresh git checkout (like Hostinger
// autodeploy), any previously-saved PDF files get wiped on every deploy.
// MongoDB data survives deploys; a saved file on disk does not. Generating
// on-demand from the DB sidesteps that entirely and also means "View" is
// always correct/fresh — no caching or stale-file edge cases possible.
exports.downloadBillPdf = async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) return res.status(404).json({ success:false, message:"Bill not found" });

    const pdfBytes = await generateInvoicePDF(bill);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${bill.invoiceNumber}.pdf"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("Download bill PDF error:", err);
    res.status(500).json({ success:false, message: `Failed to generate invoice PDF: ${err.message}` });
  }
};

exports.updateBill = async (req, res) => {
  try {
    const { shippingCharge, packagingCharge, taxPercent, paymentMode, transactionId, invoiceNumber } = req.body;

    const bill = await Bill.findById(req.params.id);
    if (!bill) return res.status(404).json({ success:false, message:"Bill not found" });

    if (transactionId && transactionId !== bill.transactionId) {
      const dupe = await Bill.findOne({ transactionId, _id: { $ne: bill._id } });
      if (dupe) return res.status(400).json({ success:false, message:"Transaction ID already exists" });
    }
    if (invoiceNumber && invoiceNumber !== bill.invoiceNumber) {
      const dupe = await Bill.findOne({ invoiceNumber, _id: { $ne: bill._id } });
      if (dupe) return res.status(400).json({ success:false, message:"Invoice number already exists" });
    }

    const ship   = shippingCharge  !== undefined ? (Number(shippingCharge)  || 0) : bill.shippingCharge;
    const pack   = packagingCharge !== undefined ? (Number(packagingCharge) || 0) : bill.packagingCharge;
    const taxPct = taxPercent      !== undefined ? (Number(taxPercent)      || 0) : bill.taxPercent;
    const taxAmount  = Math.round(((bill.subtotal + ship + pack) * taxPct) / 100);
    const grandTotal = bill.subtotal + ship + pack + taxAmount;

    const before = bill.toObject();

    bill.shippingCharge  = ship;
    bill.packagingCharge = pack;
    bill.taxPercent      = taxPct;
    bill.taxAmount        = taxAmount;
    bill.grandTotal       = grandTotal;
    if (paymentMode   !== undefined) bill.paymentMode   = paymentMode;
    if (transactionId)               bill.transactionId = transactionId;
    if (invoiceNumber)               bill.invoiceNumber = invoiceNumber;

    await bill.save();

    let pdfStale = false;
    try {
      const pdfBytes = await generateInvoicePDF(bill);
      const billsDir = ensureBillsDir();
      const filename = `${bill.invoiceNumber}.pdf`;
      fs.writeFileSync(path.join(billsDir, filename), pdfBytes);
      bill.pdfUrl = `/uploads/bills/${filename}`;
      await bill.save();
    } catch (pdfErr) {
      console.error("Regenerate invoice PDF error:", pdfErr);
      pdfStale = true;
    }

    await logAction(req, {
      action: "UPDATE",
      entity: "Bill",
      entityId: bill._id,
      entityRef: bill.invoiceNumber,
      description: `Invoice ${bill.invoiceNumber} charges updated`,
      before,
      after: bill.toObject(),
    });

    res.json({
      success: true,
      message: pdfStale
        ? "Bill updated, but the invoice PDF could not be regenerated — the downloadable file may be out of date."
        : "Bill updated successfully",
      bill,
    });
  } catch (err) {
    console.error("Update bill error:", err);
    res.status(500).json({ success:false, message: err.message });
  }
};

exports.updatePaymentStatusAdmin = async (req, res) => {
  try {
    const { paymentStatus } = req.body;
    if (!["PAID","UNPAID","PARTIAL"].includes(paymentStatus)) {
      return res.status(400).json({ success:false, message:"Invalid payment status" });
    }
    const bill = await Bill.findByIdAndUpdate(req.params.id, { paymentStatus }, { new:true });
    if (!bill) return res.status(404).json({ success:false, message:"Bill not found" });
    res.json({ success:true, message:"Payment status updated", bill });
  } catch (err) {
    res.status(500).json({ success:false, message: err.message });
  }
};

exports.deleteBill = async (req, res) => {
  try {
    const bill = await Bill.findByIdAndDelete(req.params.id);
    if (!bill) return res.status(404).json({ success:false, message:"Bill not found" });
    if (bill.pdfUrl) {
      const p = path.join(process.cwd(), bill.pdfUrl);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    await logAction(req, { action:"DELETE", entity:"Bill", entityId: bill._id, entityRef: bill.invoiceNumber, description:`Invoice ${bill.invoiceNumber} deleted` });
    res.json({ success:true, message:"Bill deleted" });
  } catch (err) {
    res.status(500).json({ success:false, message: err.message });
  }
};

exports.exportBills = async (req, res) => {
  try {
    const { format = "xlsx", sellerId, from, to } = req.query;
    const filter = {};
    if (sellerId) filter.sellerId = sellerId;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to)   filter.createdAt.$lte = new Date(to);
    }

    const bills = await Bill.find(filter).sort({ createdAt: -1 }).lean();

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Bills");
    ws.columns = [
      { header: "Invoice No",     key: "invoiceNumber", width: 16 },
      { header: "Transaction ID", key: "transactionId",  width: 26 },
      { header: "Company",        key: "company",        width: 26 },
      { header: "Product",        key: "product",        width: 30 },
      { header: "Amount",         key: "amount",         width: 14 },
      { header: "Date",           key: "date",           width: 14 },
      { header: "Payment Status", key: "paymentStatus",  width: 14 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3D2B1F" } };

    bills.forEach(b => {
      ws.addRow({
        invoiceNumber: b.invoiceNumber,
        transactionId: b.transactionId,
        company: b.buyer?.name || "—",
        product: b.items?.[0]?.name || "—",
        amount: b.grandTotal,
        date: new Date(b.invoiceDate || b.createdAt).toLocaleDateString("en-IN"),
        paymentStatus: b.paymentStatus,
      });
    });

    if (format === "csv") {
      const buffer = await wb.csv.writeBuffer();
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="bills_${Date.now()}.csv"`);
      return res.send(buffer);
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="bills_${Date.now()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Export bills error:", err);
    res.status(500).json({ success:false, message: err.message });
  }
};
