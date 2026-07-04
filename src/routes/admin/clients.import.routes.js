// src/routes/admin/clients.import.routes.js
//
// Bulk-import clients (real customers/buyers) migrated from the old site
// into the Client collection. Every Client requires a sellerId — by default
// this uses the logged-in admin's own account as the owning seller.
//
// Mount this in your main admin router, e.g. in app.js / index.js:
//   app.use("/api/admin/clients", require("./routes/admin/clients.import.routes"));
//
// NOTE: your existing clients.admin.routes.js is likely already mounted at
// "/api/admin/clients" — if so, just add these two routes into that same
// file instead of mounting a second router on the same path.

const express = require("express");
const router = express.Router();
const multer = require("multer");
const ExcelJS = require("exceljs");

const Client = require("../../models/Client.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");
const { logAction } = require("../../utils/audit");

router.use(protect, restrictTo("admin"));

const upload = multer({ storage: multer.memoryStorage() });

// ── GET /api/admin/clients/import-template ─────────────────────
router.get("/import-template", async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Clients Import");

    ws.columns = [
      { header: "name *",           key: "name",          width: 24 },
      { header: "phone *",          key: "phone",         width: 15 },
      { header: "email",            key: "email",         width: 28 },
      { header: "company",          key: "company",       width: 24 },
      { header: "gst_number",       key: "gstNumber",     width: 18 },
      { header: "street",           key: "street",        width: 24 },
      { header: "city",             key: "city",          width: 16 },
      { header: "state",            key: "state",         width: 16 },
      { header: "pincode",          key: "pincode",       width: 12 },
      { header: "wallet_balance",   key: "walletBalance", width: 15 },
      { header: "status",           key: "status",        width: 12 },
      { header: "role",             key: "role",          width: 12 },
    ];

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FF3D2B1F" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC9A84C" } };
    headerRow.height = 20;

    ws.addRow({
      name: "Rahul Sharma", phone: "9876543210", email: "rahul@example.com",
      company: "Sharma Antiques", gstNumber: "09ABCDE1234F1Z5",
      street: "12 MG Road", city: "Delhi", state: "Delhi", pincode: "110001",
      walletBalance: 0, status: "active", role: "customer",
    });

    const info = wb.addWorksheet("Instructions");
    info.getCell("A1").value = "CLIENT IMPORT — INSTRUCTIONS";
    info.getCell("A1").font = { bold: true, size: 14 };
    [
      ["A3", "* = Required field (name, phone)"],
      ["A4", "phone: 10-digit Indian mobile number starting with 6-9"],
      ["A5", "status: active or inactive (defaults to active if blank)"],
      ["A6", "role: customer, wholesale, or vip (defaults to customer if blank)"],
      ["A7", "Duplicates are checked by phone number under the same seller — existing ones are skipped, not overwritten."],
      ["A8", "All imported clients are assigned to the admin account performing the import."],
    ].forEach(([cell, text]) => { info.getCell(cell).value = text; });
    info.getColumn("A").width = 90;

    res.setHeader("Content-Disposition", 'attachment; filename="clients_import_template.xlsx"');
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[clients/import-template]", err);
    res.status(500).json({ success: false, message: "Could not generate template" });
  }
});

// ── POST /api/admin/clients/bulk-import ─────────────────────────
router.post("/bulk-import", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "File is required (field name: 'file')" });
  }

  const results = { created: 0, skipped: 0, errors: [] };
  const createdClients = [];

  // Every Client needs a sellerId — default to the admin performing the import
  const sellerId = req.body.sellerId || req.seller.id;

  try {
    const wb = new ExcelJS.Workbook();
    const isCSV = req.file.originalname.toLowerCase().endsWith(".csv");

    if (isCSV) {
      await wb.csv.read(require("stream").Readable.from(req.file.buffer));
    } else {
      await wb.xlsx.load(req.file.buffer);
    }
    const ws = wb.worksheets[0];

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
        const phone = get(row, "phone").replace(/\s/g, "");
        const email = get(row, "email").toLowerCase();

        if (!name || !phone) {
          results.errors.push({ row: rowNum, reason: "Missing required field (name/phone)" });
          continue;
        }
        if (!/^[6-9]\d{9}$/.test(phone)) {
          results.errors.push({ row: rowNum, reason: `Invalid phone number: ${phone}` });
          continue;
        }

        // Duplicate check matches the Client schema's unique index: {sellerId, phone}
        const existing = await Client.findOne({ sellerId, phone });
        if (existing) {
          results.skipped++;
          continue;
        }

        const status = ["active", "inactive"].includes(get(row, "status").toLowerCase())
          ? get(row, "status").toLowerCase() : "active";
        const role = ["customer", "wholesale", "vip"].includes(get(row, "role").toLowerCase())
          ? get(row, "role").toLowerCase() : "customer";
        const walletBalance = Number(get(row, "wallet_balance")) || 0;

        const client = await Client.create({
          name,
          phone,
          email: email || null,
          company: get(row, "company") || "",
          gstNumber: get(row, "gst_number") || "",
          address: {
            street:  get(row, "street")  || undefined,
            city:    get(row, "city")    || undefined,
            state:   get(row, "state")   || undefined,
            pincode: get(row, "pincode") || undefined,
          },
          sellerId,
          walletBalance,
          status,
          role,
        });

        createdClients.push({ name: client.name, phone: client.phone, company: client.company });
        results.created++;
      } catch (err) {
        results.errors.push({ row: rowNum, reason: err.message });
      }
    }

    await logAction(req, {
      action: "CREATE",
      entity: "Client",
      description: `Bulk import: ${results.created} created, ${results.skipped} skipped, ${results.errors.length} errors`,
    });

    res.json({
      success: true,
      message: `Import complete: ${results.created} created, ${results.skipped} skipped (duplicate phone), ${results.errors.length} errors`,
      results,
      createdClients,
    });
  } catch (err) {
    console.error("[clients/bulk-import]", err);
    res.status(500).json({ success: false, message: "Import failed: " + err.message });
  }
});

module.exports = router;
