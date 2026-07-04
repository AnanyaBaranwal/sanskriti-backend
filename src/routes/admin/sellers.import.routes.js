// src/routes/admin/sellers.import.routes.js
//
// Bulk-import sellers migrated from the old site (sanskrititheantique.in)
// into the new Seller collection.
//
// Mount this in your main admin router, e.g. in app.js / index.js:
//   app.use("/api/admin/sellers", require("./routes/admin/sellers.import.routes"));
//
// Requires the same deps already used elsewhere in this codebase:
//   multer, exceljs, crypto
// Adjust the `protect`/`adminOnly` middleware imports to match your existing
// auth middleware (used in your other admin routes).

const express = require("express");
const router = express.Router();
const multer = require("multer");
const ExcelJS = require("exceljs");
const crypto = require("crypto");
const Seller = require("../../models/Seller.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");

router.use(protect, restrictTo("admin"));

const upload = multer({ storage: multer.memoryStorage() });

// ── GET /api/admin/sellers/import-template ────────────────────
// Downloads a blank Excel template with the expected columns.
router.get("/import-template", async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sellers Import");

    ws.columns = [
      { header: "name *",          key: "name",         width: 24 },
      { header: "email *",         key: "email",        width: 28 },
      { header: "phone *",         key: "phone",        width: 15 },
      { header: "business_name",   key: "businessName", width: 24 },
      { header: "gst_number",      key: "gstNumber",     width: 18 },
      { header: "street",          key: "street",        width: 24 },
      { header: "city",            key: "city",          width: 16 },
      { header: "state",           key: "state",         width: 16 },
      { header: "pincode",         key: "pincode",       width: 12 },
      { header: "status",          key: "status",        width: 12 },
      { header: "kyc_status",      key: "kycStatus",     width: 16 },
    ];

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FF3D2B1F" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC9A84C" } };
    headerRow.height = 20;

    // Sample row
    ws.addRow({
      name: "Rahul Sharma",
      email: "rahul@example.com",
      phone: "9876543210",
      businessName: "Sharma Antiques",
      gstNumber: "09ABCDE1234F1Z5",
      street: "12 MG Road",
      city: "Delhi",
      state: "Delhi",
      pincode: "110001",
      status: "active",       // pending | active | suspended
      kycStatus: "approved",  // not_submitted | under_review | approved | rejected
    });

    // Instructions sheet
    const info = wb.addWorksheet("Instructions");
    info.getCell("A1").value = "SELLER IMPORT — INSTRUCTIONS";
    info.getCell("A1").font = { bold: true, size: 14 };
    [
      ["A3", "* = Required field (name, email, phone)"],
      ["A4", "phone: 10-digit Indian mobile number starting with 6-9"],
      ["A5", "status: pending, active, or suspended (defaults to active if blank)"],
      ["A6", "kyc_status: not_submitted, under_review, approved, or rejected (defaults to not_submitted)"],
      ["A7", "Duplicate emails already in the system will be skipped, not overwritten."],
      ["A8", "Imported sellers get a temporary password-reset link (see API response) — no password is copied from the old site."],
    ].forEach(([cell, text]) => { info.getCell(cell).value = text; });
    info.getColumn("A").width = 90;

    res.setHeader("Content-Disposition", 'attachment; filename="sellers_import_template.xlsx"');
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[sellers/import-template]", err);
    res.status(500).json({ success: false, message: "Could not generate template" });
  }
});

// ── POST /api/admin/sellers/bulk-import ────────────────────────
// Upload the filled-in template (or a CSV with the same headers).
router.post("/bulk-import", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "File is required (field name: 'file')" });
  }

  const results = { created: 0, skipped: 0, errors: [] };
  const createdSellers = [];

  try {
    const wb = new ExcelJS.Workbook();
    const isCSV = req.file.originalname.toLowerCase().endsWith(".csv");

    if (isCSV) {
      await wb.csv.read(require("stream").Readable.from(req.file.buffer));
    } else {
      await wb.xlsx.load(req.file.buffer);
    }
    const ws = wb.worksheets[0];

    // Map header row -> column index, so column order doesn't matter
    const headerMap = {};
    ws.getRow(1).eachCell((cell, colNum) => {
      const key = String(cell.value || "").toLowerCase().replace(/\s*\*?\s*$/, "").trim();
      headerMap[key] = colNum;
    });

    const get = (row, key) => {
      const col = headerMap[key];
      if (!col) return "";
      const cell = row.getCell(col);
      return (cell.text ?? cell.value ?? "").toString().trim();
    };

    const rows = [];
    ws.eachRow((row, rowNum) => { if (rowNum > 1) rows.push({ rowNum, row }); });

    for (const { rowNum, row } of rows) {
      try {
        const name  = get(row, "name");
        const email = get(row, "email").toLowerCase();
        const phone = get(row, "phone").replace(/\s/g, "");

        if (!name || !email || !phone) {
          results.errors.push({ row: rowNum, reason: "Missing required field (name/email/phone)" });
          continue;
        }
        if (!/^[6-9]\d{9}$/.test(phone)) {
          results.errors.push({ row: rowNum, reason: `Invalid phone number: ${phone}` });
          continue;
        }
        if (!/^\S+@\S+\.\S+$/.test(email)) {
          results.errors.push({ row: rowNum, reason: `Invalid email: ${email}` });
          continue;
        }

        const existing = await Seller.findOne({ email });
        if (existing) {
          results.skipped++;
          continue;
        }

        // Random placeholder password — never communicated. Sellers set
        // their own password via the reset-token link below.
        const placeholderPassword = crypto.randomBytes(16).toString("hex");
        const resetToken = crypto.randomBytes(32).toString("hex");
        const resetExpires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days

        const status = ["pending", "active", "suspended"].includes(get(row, "status").toLowerCase())
          ? get(row, "status").toLowerCase() : "active";
        const kycStatus = ["not_submitted", "under_review", "approved", "rejected"].includes(get(row, "kyc_status").toLowerCase())
          ? get(row, "kyc_status").toLowerCase() : "not_submitted";

        const seller = await Seller.create({
          name,
          email,
          phone,
          passwordHash: placeholderPassword, // hashed by pre-save hook
          businessName: get(row, "business_name") || undefined,
          gstNumber:    get(row, "gst_number") || undefined,
          address: {
            street:  get(row, "street")  || undefined,
            city:    get(row, "city")    || undefined,
            state:   get(row, "state")   || undefined,
            pincode: get(row, "pincode") || undefined,
          },
          status,
          kycStatus,
          isEmailVerified: true, // already verified on old site — adjust if not desired
          passwordResetToken: resetToken,
          passwordResetExpires: resetExpires,
        });

        createdSellers.push({
          email: seller.email,
          name: seller.name,
          resetLink: `${process.env.FRONTEND_URL || "https://vyrelle.in"}/reset-password?token=${resetToken}`,
        });
        results.created++;
      } catch (err) {
        results.errors.push({ row: rowNum, reason: err.message });
      }
    }

    res.json({
      success: true,
      message: `Import complete: ${results.created} created, ${results.skipped} skipped (duplicate email), ${results.errors.length} errors`,
      results,
      createdSellers, // contains password-reset links to send sellers, e.g. via email/WhatsApp
    });
  } catch (err) {
    console.error("[sellers/bulk-import]", err);
    res.status(500).json({ success: false, message: "Import failed: " + err.message });
  }
});

module.exports = router;
