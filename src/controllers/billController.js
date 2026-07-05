const fs   = require("fs");
const path = require("path");
const Bill   = require("../models/Bill.model");
const Order  = require("../models/Order.model");
const Seller = require("../models/kyc.model");

// ── Ensure uploads/bills dir ──────────────────────────────────
const ensureBillsDir = () => {
  const dir = path.join(process.cwd(), "uploads", "bills");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// ── Format money (no ₹ symbol — uses Rs. for PDF compatibility)
const fmt = (n) => `Rs. ${(n || 0).toLocaleString("en-IN")}`;

// ── Generate PDF using pdf-lib ────────────────────────────────
const generateInvoicePDF = async (bill) => {
  const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

  const doc  = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4
  const W    = 595;
  const H    = 842;

  const bold    = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);

  // ── Colours ──
  const GOLD       = rgb(0.788, 0.659, 0.298);
  const DARK_BROWN = rgb(0.173, 0.094, 0.063); // #2C1810
  const MID_BROWN  = rgb(0.239, 0.169, 0.122); // #3D2B1F
  const BLACK      = rgb(0.1,   0.1,   0.1);
  const GRAY       = rgb(0.45,  0.45,  0.45);
  const LIGHT      = rgb(0.96,  0.94,  0.91);
  const WHITE      = rgb(1,     1,     1);
  const GREEN      = rgb(0.08,  0.5,   0.18);
  const RED        = rgb(0.75,  0.12,  0.12);
  const BLUE       = rgb(0.11,  0.33,  0.72);

  // ── Header band ──
  page.drawRectangle({ x:0, y:H-90, width:W, height:90, color:DARK_BROWN });

  // Brand
  page.drawText("SANSKRITI", { x:36, y:H-38, size:26, font:bold, color:GOLD });
  page.drawText("THE ANTIQUE", { x:37, y:H-56, size:9,  font:regular, color:rgb(0.82,0.72,0.55) });

  // Separator line in header
  page.drawRectangle({ x:36, y:H-65, width:120, height:0.5, color:rgb(0.6,0.5,0.3) });

  // TAX INVOICE label
  page.drawText("TAX INVOICE", { x:W-165, y:H-38, size:18, font:bold, color:GOLD });
  page.drawText(`No: ${bill.invoiceNumber}`, { x:W-165, y:H-57, size:8.5, font:regular, color:rgb(0.85,0.76,0.56) });
  const dateStr = new Date(bill.createdAt).toLocaleDateString("en-IN", {
    day:"numeric", month:"long", year:"numeric"
  });
  page.drawText(`Date: ${dateStr}`, { x:W-165, y:H-70, size:8, font:regular, color:rgb(0.75,0.65,0.45) });

  // ── Seller & Buyer boxes ──
  let Y = H - 110;

  // Box backgrounds
  page.drawRectangle({ x:30,  y:Y-90, width:240, height:92, color:LIGHT });
  page.drawRectangle({ x:320, y:Y-90, width:240, height:92, color:LIGHT });

  // Box top accent lines
  page.drawRectangle({ x:30,  y:Y+1, width:240, height:3, color:GOLD });
  page.drawRectangle({ x:320, y:Y+1, width:240, height:3, color:GOLD });

  const drawBox = (data, xOff) => {
    let by = Y - 14;
    page.drawText(data.label, { x:xOff+8, y:Y-12, size:7.5, font:bold, color:GRAY });
    page.drawText(data.name,  { x:xOff+8, y:by-10, size:11, font:bold, color:MID_BROWN });
    by -= 26;
    if (data.gst)   { page.drawText(`GSTIN: ${data.gst}`, { x:xOff+8, y:by, size:8, font:regular, color:BLACK }); by -= 13; }
    if (data.phone) { page.drawText(data.phone,             { x:xOff+8, y:by, size:8, font:regular, color:BLACK }); by -= 13; }
    if (data.email) { page.drawText(data.email,             { x:xOff+8, y:by, size:8, font:regular, color:GRAY  }); by -= 13; }
    if (data.addr)  {
      const a = data.addr.length > 42 ? data.addr.substring(0,42)+"..." : data.addr;
      page.drawText(a, { x:xOff+8, y:by, size:8, font:regular, color:GRAY }); by -= 13;
    }
  };

  const sellerAddr = [
    bill.seller?.address?.street,
    bill.seller?.address?.city,
    bill.seller?.address?.state,
    bill.seller?.address?.pincode,
  ].filter(Boolean).join(", ");

  const buyerAddr = [
    bill.buyer?.address?.street,
    bill.buyer?.address?.city,
    bill.buyer?.address?.state,
    bill.buyer?.address?.pincode,
  ].filter(Boolean).join(", ");

  drawBox({ label:"FROM (SELLER)", name: bill.seller?.businessName || bill.seller?.name || "Seller", gst:bill.seller?.gstNumber, phone:bill.seller?.phone, email:bill.seller?.email, addr:sellerAddr }, 30);
  drawBox({ label:"BILLED TO (BUYER)", name: bill.buyer?.name || "Buyer", gst:null, phone:bill.buyer?.phone, email:bill.buyer?.email, addr:buyerAddr }, 320);

  // ── Items table ──
  Y = Y - 104;

  // Table header row
  page.drawRectangle({ x:30, y:Y-20, width:W-60, height:22, color:DARK_BROWN });
  const cols = [
    { label:"#",      x:38  },
    { label:"ITEM",   x:58  },
    { label:"QTY",    x:330 },
    { label:"RATE",   x:375 },
    { label:"AMOUNT", x:470 },
  ];
  cols.forEach(c => page.drawText(c.label, { x:c.x, y:Y-14, size:8, font:bold, color:WHITE }));

  Y -= 22;

  // Item rows
  bill.items.forEach((item, idx) => {
    const rowH     = item.description ? 28 : 20;
    const rowColor = idx % 2 === 0 ? WHITE : LIGHT;
    page.drawRectangle({ x:30, y:Y-rowH, width:W-60, height:rowH, color:rowColor });

    const name = (item.name || "").length > 36 ? item.name.substring(0,36)+"..." : (item.name || "");
    page.drawText(String(idx+1),               { x:38,  y:Y-13, size:8, font:regular, color:BLACK });
    page.drawText(name,                        { x:58,  y:Y-13, size:8, font:regular, color:BLACK });
    page.drawText(String(item.quantity || 1),  { x:335, y:Y-13, size:8, font:regular, color:BLACK });
    page.drawText(fmt(item.price),             { x:365, y:Y-13, size:8, font:regular, color:BLACK });
    page.drawText(fmt(item.total),             { x:460, y:Y-13, size:8, font:bold,    color:BLACK });

    if (item.description) {
      const desc = item.description.length > 44 ? item.description.substring(0,44)+"..." : item.description;
      page.drawText(desc, { x:58, y:Y-24, size:7, font:regular, color:GRAY });
    }
    Y -= rowH;
  });

  // Table bottom line
  page.drawRectangle({ x:30, y:Y, width:W-60, height:0.8, color:rgb(0.75,0.65,0.5) });

  // ── Totals ──
  Y -= 12;
  const TX = 370; // totals label x
  const VX = 510; // totals value x (right-aligned manually)

  const drawTotalRow = (label, value, isBold=false, isHighlight=false) => {
    if (isHighlight) {
      page.drawRectangle({ x:TX-10, y:Y-6, width:W-TX-20, height:22, color:DARK_BROWN });
      page.drawText(label, { x:TX, y:Y+2, size:10, font:bold,    color:GOLD });
      page.drawText(value, { x:VX, y:Y+2, size:10, font:bold,    color:GOLD });
    } else {
      page.drawText(label, { x:TX, y:Y, size:9, font:isBold?bold:regular, color:isBold?MID_BROWN:BLACK });
      page.drawText(value, { x:VX, y:Y, size:9, font:isBold?bold:regular, color:isBold?MID_BROWN:BLACK });
    }
    Y -= isHighlight ? 26 : 17;
  };

  drawTotalRow("Subtotal:",         fmt(bill.subtotal));
  if (bill.isIntraState) {
    drawTotalRow("CGST (9%):",      fmt(bill.cgst));
    drawTotalRow("SGST (9%):",      fmt(bill.sgst));
  } else {
    drawTotalRow("IGST (18%):",     fmt(bill.igst));
  }
  if ((bill.discount||0) > 0) {
    drawTotalRow("Discount:",       `- ${fmt(bill.discount)}`);
  }
  Y -= 4;
  drawTotalRow("GRAND TOTAL",       fmt(bill.grandTotal), true, true);

  // ── Payment badge ──
  Y -= 6;
  const badgeColor = bill.paymentStatus==="PAID" ? GREEN : bill.paymentStatus==="PARTIAL" ? BLUE : RED;
  page.drawRectangle({ x:32, y:Y-4, width:80, height:18, color:badgeColor });
  page.drawText(bill.paymentStatus, { x:40, y:Y+2, size:8.5, font:bold, color:WHITE });

  // GST type note
  const gstNote = bill.isIntraState
    ? "Intra-state supply: CGST + SGST applicable"
    : "Inter-state supply: IGST applicable";
  page.drawText(gstNote, { x:130, y:Y+2, size:8, font:regular, color:GRAY });

  // ── Notes ──
  if (bill.notes) {
    Y -= 24;
    page.drawText("Notes:", { x:32, y:Y, size:8.5, font:bold, color:MID_BROWN });
    page.drawText(bill.notes.substring(0,100), { x:32, y:Y-13, size:8, font:regular, color:GRAY });
  }

  // ── Terms ──
  Y -= 40;
  if (Y > 80) {
    page.drawRectangle({ x:30, y:Y-30, width:W-60, height:0.5, color:LIGHT });
    page.drawText("Terms & Conditions:", { x:32, y:Y-10, size:8, font:bold, color:GRAY });
    page.drawText("1. Goods once sold will not be taken back or exchanged.  2. Subject to jurisdiction of seller's city.", {
      x:32, y:Y-22, size:7.5, font:regular, color:GRAY
    });
  }

  // ── Footer band ──
  page.drawRectangle({ x:0, y:0, width:W, height:44, color:DARK_BROWN });
  page.drawText("Thank you for your purchase from Sanskriti The Antique", {
    x:W/2 - 162, y:26, size:9, font:regular, color:GOLD
  });
  page.drawText("This is a computer generated invoice | sanskriti.vyrelle.in", {
    x:W/2 - 148, y:12, size:7.5, font:regular, color:rgb(0.6,0.5,0.35)
  });

  return await doc.save();
};

// ── POST /api/bills/generate/:orderId ─────────────────────────
exports.generateBill = async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.orderId,
      sellerId: req.seller.id,
    });

    if (!order) return res.status(404).json({ success:false, message:"Order not found" });

    // Block duplicate — return existing bill
    const existing = await Bill.findOne({ orderId: order._id });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: "Bill already generated for this order",
        bill: existing,
      });
    }

    const seller = await Seller.findById(req.seller.id);

    // Intra-state vs inter-state
    const sellerState = (seller?.address?.state || "").trim().toLowerCase();
    const buyerState  = (order.buyer?.address?.state || "").trim().toLowerCase();
    const isIntraState = !!sellerState && sellerState === buyerState;

    const tax     = order.taxAmount || 0;
    const halfTax = Math.round(tax / 2);
    const cgst    = isIntraState ? halfTax : 0;
    const sgst    = isIntraState ? (tax - halfTax) : 0; // handles odd numbers
    const igst    = isIntraState ? 0 : tax;

    // Create bill document
    const bill = await Bill.create({
      sellerId:      req.seller.id,
      orderId:       order._id,
      buyer:         order.buyer,
      seller: {
        name:         seller?.name,
        businessName: seller?.businessName,
        email:        seller?.email,
        phone:        seller?.phone,
        gstNumber:    seller?.gstNumber,
        address:      seller?.address,
      },
      items: order.items.map(item => ({
        name:        item.name,
        description: item.description,
        quantity:    item.quantity,
        price:       item.price,
        total:       item.total,
      })),
      subtotal:      order.subtotal    || 0,
      cgst,
      sgst,
      igst,
      totalTax:      tax,
      discount:      order.discountAmount || 0,
      grandTotal:    order.total       || 0,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus === "PAID" ? "PAID" : "UNPAID",
      notes:         order.notes,
      isIntraState,
    });

    // Generate PDF
    const pdfBytes = await generateInvoicePDF(bill);

    // Save to disk
    const billsDir  = ensureBillsDir();
    const filename  = `${bill.invoiceNumber}.pdf`;
    const filepath  = path.join(billsDir, filename);
    fs.writeFileSync(filepath, pdfBytes);

    // Store URL on bill
    const pdfUrl = `/uploads/bills/${filename}`;
    await Bill.findByIdAndUpdate(bill._id, { pdfUrl });
    bill.pdfUrl = pdfUrl;

    res.status(201).json({
      success:     true,
      message:     "Invoice generated successfully",
      bill:        { ...bill.toObject(), pdfUrl },
      downloadUrl: `http://localhost:5000${pdfUrl}`,
    });

  } catch (error) {
    console.error("Generate bill error:", error);
    res.status(500).json({ success:false, message:"Server error: " + error.message });
  }
};

// ── GET /api/bills ────────────────────────────────────────────
exports.getBills = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip  = (page - 1) * limit;

    const [bills, total] = await Promise.all([
      Bill.find({ sellerId: req.seller.id })
        .populate("orderId", "orderNumber status")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Bill.countDocuments({ sellerId: req.seller.id }),
    ]);

    res.status(200).json({
      success: true,
      bills,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ success:false, message:"Server error" });
  }
};

// ── GET /api/bills/:id ────────────────────────────────────────
exports.getBillById = async (req, res) => {
  try {
    const bill = await Bill.findOne({
      _id:      req.params.id,
      sellerId: req.seller.id,
    }).populate("orderId", "orderNumber status");

    if (!bill) return res.status(404).json({ success:false, message:"Bill not found" });

    res.status(200).json({ success:true, bill });
  } catch (error) {
    res.status(500).json({ success:false, message:"Server error" });
  }
};

// ── GET /api/bills/:id/download ───────────────────────────────
exports.downloadBill = async (req, res) => {
  try {
    const bill = await Bill.findOne({
      _id:      req.params.id,
      sellerId: req.seller.id,
    });

    if (!bill) return res.status(404).json({ success:false, message:"Bill not found" });

    // If pdfUrl missing or file deleted — regenerate
    const filepath = bill.pdfUrl
      ? path.join(process.cwd(), bill.pdfUrl)
      : null;

    if (!filepath || !fs.existsSync(filepath)) {
      // Regenerate
      const pdfBytes  = await generateInvoicePDF(bill);
      const billsDir  = ensureBillsDir();
      const filename  = `${bill.invoiceNumber}.pdf`;
      const newPath   = path.join(billsDir, filename);
      fs.writeFileSync(newPath, pdfBytes);
      const pdfUrl = `/uploads/bills/${filename}`;
      await Bill.findByIdAndUpdate(bill._id, { pdfUrl });

      res.setHeader("Content-Type",        "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${bill.invoiceNumber}.pdf"`);
      return res.end(Buffer.from(pdfBytes));
    }

    res.setHeader("Content-Type",        "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${bill.invoiceNumber}.pdf"`);
    fs.createReadStream(filepath).pipe(res);

  } catch (error) {
    console.error("Download bill error:", error);
    res.status(500).json({ success:false, message:"Server error: " + error.message });
  }
};

// ── PATCH /api/bills/:id/payment ──────────────────────────────
exports.updatePaymentStatus = async (req, res) => {
  try {
    const { paymentStatus } = req.body;

    if (!["PAID","UNPAID","PARTIAL"].includes(paymentStatus)) {
      return res.status(400).json({ success:false, message:"Invalid payment status" });
    }

    const bill = await Bill.findOneAndUpdate(
      { _id:req.params.id, sellerId:req.seller.id },
      { paymentStatus },
      { new:true }
    );

    if (!bill) return res.status(404).json({ success:false, message:"Bill not found" });

    res.status(200).json({ success:true, message:"Payment status updated", bill });
  } catch (error) {
    res.status(500).json({ success:false, message:"Server error" });
  }
};
