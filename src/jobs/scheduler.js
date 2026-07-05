const cron        = require("node-cron");
const nodemailer  = require("nodemailer");
const Product     = require("../models/Product.model");
const Bill        = require("../models/Bill.model");
const Order       = require("../models/Order.model");
const Seller      = require("../models/kyc.model");

// Reuse same transporter config as email.service.js
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   Number(process.env.SMTP_PORT),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// Generic send helper used only inside this file
const sendEmail = ({ to, subject, html }) =>
  transporter.sendMail({
    from: `"Sanskriti Admin" <${process.env.SMTP_USER}>`,
    to, subject, html,
  });

// ── Helper: get admin email ───────────────────────────────────
const getAdminEmail = async () => {
  const admin = await Seller.findOne({ role: "admin" }).select("email name");
  return admin;
};

// ── JOB 1: Daily 9am — Low stock + out-of-stock alert ────────
cron.schedule("0 9 * * *", async () => {
  console.log("[Scheduler] Running low stock check...");
  try {
    const admin = await getAdminEmail();
    if (!admin) return;

    const lowStock = await Product.find({
      isActive: true,
      stock: { $gt: 0 },
      $expr: { $lte: ["$stock", "$reorderLevel"] },
    }).lean({ virtuals: true });

    const outOfStock = await Product.find({ isActive: true, stock: 0 }).lean();

    if (lowStock.length === 0 && outOfStock.length === 0) return;

    const lowRows = lowStock.map(p =>
      `<tr><td>${p.name}</td><td>${p.sku || "-"}</td><td style="color:#854F0B">${p.stock}</td><td>${p.reorderLevel}</td></tr>`
    ).join("");

    const outRows = outOfStock.map(p =>
      `<tr><td>${p.name}</td><td>${p.sku || "-"}</td><td style="color:#A32D2D">0</td><td>${p.reorderLevel}</td></tr>`
    ).join("");

    const html = `
      <h2>📦 Daily Inventory Alert</h2>
      ${outOfStock.length > 0 ? `
        <h3 style="color:#A32D2D">Out of Stock (${outOfStock.length})</h3>
        <table border="1" cellpadding="6" style="border-collapse:collapse;width:100%">
          <tr><th>Product</th><th>SKU</th><th>Stock</th><th>Reorder At</th></tr>
          ${outRows}
        </table>` : ""}
      ${lowStock.length > 0 ? `
        <h3 style="color:#854F0B">Low Stock (${lowStock.length})</h3>
        <table border="1" cellpadding="6" style="border-collapse:collapse;width:100%">
          <tr><th>Product</th><th>SKU</th><th>Stock</th><th>Reorder At</th></tr>
          ${lowRows}
        </table>` : ""}
    `;

    await sendEmail({
      to:      admin.email,
      subject: `⚠️ Inventory Alert: ${outOfStock.length} out of stock, ${lowStock.length} low stock`,
      html,
    });

    console.log(`[Scheduler] Stock alert sent: ${outOfStock.length} OOS, ${lowStock.length} low`);
  } catch (err) {
    console.error("[Scheduler] Low stock job failed:", err.message);
  }
});

// ── JOB 2: Daily 8am — Payment reminder emails ───────────────
// Sends reminders for unpaid bills at day 7, 15, and 30
cron.schedule("0 8 * * *", async () => {
  console.log("[Scheduler] Running payment reminder check...");
  try {
    const now = Date.now();
    const thresholds = [
      { days: 7,  label: "7 days" },
      { days: 15, label: "15 days" },
      { days: 30, label: "30 days" },
    ];

    for (const { days, label } of thresholds) {
      const from = new Date(now - (days + 1) * 24 * 60 * 60 * 1000);
      const to   = new Date(now - days       * 24 * 60 * 60 * 1000);

      const overdueBills = await Bill.find({
        paymentStatus: "UNPAID",
        createdAt: { $gte: from, $lte: to },
      }).lean();

      for (const bill of overdueBills) {
        const buyerEmail = bill.buyer?.email;
        const buyerName  = bill.buyer?.name || "Customer";
        if (!buyerEmail) continue;

        await sendEmail({
          to:      buyerEmail,
          subject: `Payment Reminder — Invoice ${bill.invoiceNumber} is ${label} overdue`,
          html: `
            <p>Dear ${buyerName},</p>
            <p>This is a friendly reminder that invoice <strong>${bill.invoiceNumber}</strong>
            for <strong>₹${bill.grandTotal?.toLocaleString("en-IN")}</strong> is overdue by ${label}.</p>
            <p>Please make the payment at your earliest convenience.</p>
            <p>Thank you,<br/>Sanskriti Team</p>
          `,
        });
      }

      if (overdueBills.length > 0) {
        console.log(`[Scheduler] Sent ${overdueBills.length} reminders for ${label} overdue bills`);
      }
    }
  } catch (err) {
    console.error("[Scheduler] Payment reminder job failed:", err.message);
  }
});

// ── JOB 3: Every Monday 8am — Weekly sales summary to admin ──
cron.schedule("0 8 * * 1", async () => {
  console.log("[Scheduler] Generating weekly sales summary...");
  try {
    const admin = await getAdminEmail();
    if (!admin) return;

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [orders, bills] = await Promise.all([
      Order.find({ createdAt: { $gte: weekAgo } }).lean(),
      Bill.find({ createdAt: { $gte: weekAgo }, paymentStatus: "PAID" }).lean(),
    ]);

    const totalOrders   = orders.length;
    const totalRevenue  = bills.reduce((s, b) => s + (b.grandTotal || 0), 0);
    const pendingOrders = orders.filter(o => o.status === "PENDING").length;
    const deliveredOrders = orders.filter(o => o.status === "DELIVERED").length;

    await sendEmail({
      to:      admin.email,
      subject: `📊 Weekly Sales Summary — ${new Date().toDateString()}`,
      html: `
        <h2>Weekly Sales Summary</h2>
        <p>Period: Last 7 days</p>
        <table border="1" cellpadding="8" style="border-collapse:collapse">
          <tr><td><strong>Total Orders</strong></td><td>${totalOrders}</td></tr>
          <tr><td><strong>Delivered</strong></td><td>${deliveredOrders}</td></tr>
          <tr><td><strong>Pending</strong></td><td>${pendingOrders}</td></tr>
          <tr><td><strong>Revenue Collected</strong></td><td>₹${totalRevenue.toLocaleString("en-IN")}</td></tr>
        </table>
        <br/>
        <p style="color:#888">Auto-generated by Sanskriti Admin</p>
      `,
    });

    console.log("[Scheduler] Weekly summary sent to admin");
  } catch (err) {
    console.error("[Scheduler] Weekly summary job failed:", err.message);
  }
});

// ── JOB 4: 1st of every month 7am — Monthly report ──────────
cron.schedule("0 7 1 * *", async () => {
  console.log("[Scheduler] Generating monthly report...");
  try {
    const admin = await getAdminEmail();
    if (!admin) return;

    const now       = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthEnd   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const orders = await Order.find({ createdAt: { $gte: monthStart, $lte: monthEnd } }).lean();
    const bills  = await Bill.find({ createdAt: { $gte: monthStart, $lte: monthEnd }, paymentStatus: "PAID" }).lean();

    const revenue = bills.reduce((s, b) => s + (b.grandTotal || 0), 0);
    const monthName = monthStart.toLocaleString("en-IN", { month: "long", year: "numeric" });

    await sendEmail({
      to:      admin.email,
      subject: `📅 Monthly Report — ${monthName}`,
      html: `
        <h2>Monthly Report: ${monthName}</h2>
        <table border="1" cellpadding="8" style="border-collapse:collapse">
          <tr><td><strong>Total Orders</strong></td><td>${orders.length}</td></tr>
          <tr><td><strong>Delivered</strong></td><td>${orders.filter(o => o.status === "DELIVERED").length}</td></tr>
          <tr><td><strong>Returned</strong></td><td>${orders.filter(o => o.status === "RETURNED").length}</td></tr>
          <tr><td><strong>Revenue Collected</strong></td><td>₹${revenue.toLocaleString("en-IN")}</td></tr>
        </table>
        <p style="color:#888">Auto-generated by Sanskriti Admin</p>
      `,
    });

    console.log(`[Scheduler] Monthly report sent for ${monthName}`);
  } catch (err) {
    console.error("[Scheduler] Monthly report job failed:", err.message);
  }
});

console.log("✅ Scheduler started — all cron jobs active");
