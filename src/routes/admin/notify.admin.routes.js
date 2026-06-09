const express    = require("express");
const router     = express.Router();
const nodemailer = require("nodemailer");
const axios      = require("axios");

const Client  = require("../../models/Client.model");
const Order   = require("../../models/Order.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");
const { logAction } = require("../../utils/audit");

router.use(protect, restrictTo("admin"));

// Reuse transporter
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   Number(process.env.SMTP_PORT),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ── POST /api/admin/notify/email-bulk ────────────────────────
// Body: { clientIds: [], subject: "", body: "" }
// OR:   { all: true, subject: "", body: "" }
router.post("/email-bulk", async (req, res) => {
  try {
    const { clientIds, all, subject, body } = req.body;

    if (!subject?.trim() || !body?.trim()) {
      return res.status(400).json({ success: false, message: "Subject and body are required" });
    }

    let clients;
    if (all) {
      clients = await Client.find({ email: { $ne: null, $exists: true } }).select("name email").lean();
    } else {
      if (!clientIds?.length) return res.status(400).json({ success: false, message: "clientIds or all:true required" });
      clients = await Client.find({ _id: { $in: clientIds }, email: { $ne: null } }).select("name email").lean();
    }

    const results = { sent: 0, failed: 0, errors: [] };

    for (const client of clients) {
      if (!client.email) { results.failed++; continue; }
      try {
        await transporter.sendMail({
          from:    `"Sanskriti" <${process.env.SMTP_USER}>`,
          to:      client.email,
          subject,
          html: `
            <div style="font-family:sans-serif;max-width:500px;margin:auto;padding:24px">
              <h2 style="color:#2C1810;font-family:Georgia,serif">${subject}</h2>
              <div style="color:#444;line-height:1.6">${body.replace(/\n/g, "<br/>")}</div>
              <hr style="border:none;border-top:1px solid #E8D5A3;margin:24px 0"/>
              <p style="color:#A08060;font-size:12px">Sanskriti The Antique · sanskriti.vyrelle.in</p>
            </div>
          `,
        });
        results.sent++;
      } catch (err) {
        results.failed++;
        results.errors.push({ name: client.name, reason: err.message });
      }
    }

    await logAction(req, {
      action:      "OTHER",
      entity:      "System",
      description: `Bulk email sent: ${results.sent} sent, ${results.failed} failed. Subject: "${subject}"`,
    });

    res.json({ success: true, message: `Email sent to ${results.sent} clients`, results });
  } catch (err) {
    console.error("[notify/email-bulk]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /api/admin/notify/whatsapp-bulk ─────────────────────
// Requires WATI_API_KEY and WATI_API_ENDPOINT in .env
// Body: { clientIds: [], templateName: "", params: {} }
router.post("/whatsapp-bulk", async (req, res) => {
  try {
    const { clientIds, all, templateName, params = {}, customMessage } = req.body;

    if (!process.env.WATI_API_KEY || !process.env.WATI_API_ENDPOINT) {
      return res.status(503).json({ success: false, message: "WhatsApp (WATI) not configured. Add WATI_API_KEY and WATI_API_ENDPOINT to .env" });
    }

    let clients;
    if (all) {
      clients = await Client.find({}).select("name phone").lean();
    } else {
      if (!clientIds?.length) return res.status(400).json({ success: false, message: "clientIds or all:true required" });
      clients = await Client.find({ _id: { $in: clientIds } }).select("name phone").lean();
    }

    const results = { sent: 0, failed: 0, errors: [] };

    for (const client of clients) {
      if (!client.phone) { results.failed++; continue; }

      // Format phone for WATI (Indian: add 91 prefix, remove leading 0)
      const phone = client.phone.replace(/^0/, "").replace(/^\+/, "");
      const fullPhone = phone.startsWith("91") ? phone : `91${phone}`;

      try {
        // WATI API: send template message
        await axios.post(
          `${process.env.WATI_API_ENDPOINT}/api/v1/sendTemplateMessage`,
          {
            template_name: templateName || "custom_message",
            broadcast_name: `admin_blast_${Date.now()}`,
            parameters: Object.entries(params).map(([name, value]) => ({ name, value })),
            // If no template, send as text (requires WATI approved template)
            ...(customMessage ? { message: customMessage } : {}),
          },
          {
            params:  { whatsappNumber: fullPhone },
            headers: { Authorization: `Bearer ${process.env.WATI_API_KEY}`, "Content-Type": "application/json" },
          }
        );
        results.sent++;
      } catch (err) {
        results.failed++;
        results.errors.push({ name: client.name, reason: err.response?.data?.message || err.message });
      }

      // Rate limit: 10 messages/second max
      await new Promise(r => setTimeout(r, 120));
    }

    await logAction(req, {
      action:      "OTHER",
      entity:      "System",
      description: `Bulk WhatsApp sent: ${results.sent} sent, ${results.failed} failed. Template: "${templateName}"`,
    });

    res.json({ success: true, message: `WhatsApp sent to ${results.sent} clients`, results });
  } catch (err) {
    console.error("[notify/whatsapp-bulk]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /api/admin/notify/order-status ──────────────────────
// Auto-notify buyer on order status change
// Called internally from order status update (or manually)
// Body: { orderId, status, note }
router.post("/order-status", async (req, res) => {
  try {
    const { orderId, status, note } = req.body;

    const order = await Order.findById(orderId).lean();
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    const buyerEmail = order.buyer?.email;
    const buyerName  = order.buyer?.name || "Customer";

    const statusMessages = {
      CONFIRMED:  "Your order has been confirmed and is being prepared.",
      PROCESSING: "Your order is currently being processed.",
      PACKED:     "Your order has been packed and is ready for dispatch.",
      SHIPPED:    "Great news! Your order has been shipped.",
      DELIVERED:  "Your order has been delivered. Thank you for shopping with us!",
      CANCELLED:  "Your order has been cancelled.",
      RETURNED:   "Your return has been processed.",
    };

    const statusMsg = statusMessages[status] || `Your order status has been updated to ${status}.`;

    if (buyerEmail) {
      await transporter.sendMail({
        from:    `"Sanskriti" <${process.env.SMTP_USER}>`,
        to:      buyerEmail,
        subject: `Order ${order.orderNumber} — ${status}`,
        html: `
          <div style="font-family:sans-serif;max-width:500px;margin:auto;padding:24px">
            <h2 style="color:#2C1810;font-family:Georgia,serif">Order Update</h2>
            <p style="color:#444">Dear ${buyerName},</p>
            <p style="color:#444">${statusMsg}</p>
            <div style="background:#FBF7F0;border:1px solid #E8D5A3;borderRadius:8px;padding:14px;margin:16px 0">
              <div style="font-size:13px;color:#6B4F12"><strong>Order:</strong> ${order.orderNumber}</div>
              <div style="font-size:13px;color:#6B4F12"><strong>Status:</strong> ${status}</div>
              <div style="font-size:13px;color:#6B4F12"><strong>Amount:</strong> ₹${order.total?.toLocaleString("en-IN")}</div>
              ${note ? `<div style="font-size:12px;color:#A08060;margin-top:8px">${note}</div>` : ""}
            </div>
            <p style="color:#A08060;font-size:12px">Sanskriti The Antique · sanskriti.vyrelle.in</p>
          </div>
        `,
      });
    }

    res.json({ success: true, message: buyerEmail ? "Notification sent" : "No email on file — skipped" });
  } catch (err) {
    console.error("[notify/order-status]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/notify/clients ────────────────────────────
// List clients for the notification selector
router.get("/clients", async (req, res) => {
  try {
    const { search } = req.query;
    const filter = {};
    if (search) filter.$or = [{ name: { $regex: search, $options: "i" } }, { phone: { $regex: search, $options: "i" } }];

    const clients = await Client.find(filter)
      .select("name phone email totalOrders")
      .sort({ totalRevenue: -1 })
      .limit(100)
      .lean();

    res.json({ success: true, clients });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
