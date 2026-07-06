const fs   = require("fs");
const path = require("path");
const Bill = require("../models/Bill.model");
const { generateInvoicePDF, ensureBillsDir } = require("../utils/invoicePdf");

// ── GET /api/bills ──────────────────────────────────────────────
exports.getBills = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip  = (page - 1) * limit;

    const [bills, total] = await Promise.all([
      Bill.find({ sellerId: req.seller.id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Bill.countDocuments({ sellerId: req.seller.id }),
    ]);

    res.status(200).json({
      success: true,
      bills,
      total,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ success:false, message:"Server error" });
  }
};

// ── GET /api/bills/:id ──────────────────────────────────────────
exports.getBillById = async (req, res) => {
  try {
    const bill = await Bill.findOne({ _id: req.params.id, sellerId: req.seller.id });
    if (!bill) return res.status(404).json({ success:false, message:"Bill not found" });
    res.status(200).json({ success:true, bill });
  } catch (error) {
    res.status(500).json({ success:false, message:"Server error" });
  }
};

// ── GET /api/bills/:id/download ──────────────────────────────────
// Seller can only download a PDF admin already generated. If it's
// missing on disk we regenerate the SAME stored data (not new terms) —
// this is not "seller generating a bill", just re-rendering the PDF file.
exports.downloadBill = async (req, res) => {
  try {
    const bill = await Bill.findOne({ _id: req.params.id, sellerId: req.seller.id });
    if (!bill) return res.status(404).json({ success:false, message:"Bill not found" });

    let filepath = bill.pdfUrl ? path.join(process.cwd(), bill.pdfUrl) : null;

    if (!filepath || !fs.existsSync(filepath)) {
      const pdfBytes = await generateInvoicePDF(bill);
      const billsDir = ensureBillsDir();
      const filename  = `${bill.invoiceNumber}.pdf`;
      filepath = path.join(billsDir, filename);
      fs.writeFileSync(filepath, pdfBytes);
      await Bill.findByIdAndUpdate(bill._id, { pdfUrl: `/uploads/bills/${filename}` });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${bill.invoiceNumber}.pdf"`);
    fs.createReadStream(filepath).pipe(res);
  } catch (error) {
    res.status(500).json({ success:false, message:"Server error: " + error.message });
  }
};

module.exports.generateInvoicePDF = generateInvoicePDF;
module.exports.ensureBillsDir     = ensureBillsDir;