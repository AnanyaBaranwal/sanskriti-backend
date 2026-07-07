require("dotenv").config();

const express      = require("express");
const cors         = require("cors");
const helmet       = require("helmet");
const rateLimit    = require("express-rate-limit");
const path         = require("path");
const cookieParser = require("cookie-parser");

const connectDB      = require("./config/db");
const authRoutes     = require("./routes/auth.routes");
const sellerRoutes   = require("./routes/seller.routes");
const walletRoutes   = require("./routes/wallet.routes");
const paymentRoutes  = require("./routes/payment.routes");
const payoutRoutes   = require("./routes/payout.routes");
const orderRoutes    = require("./routes/order.routes");
const billRoutes     = require("./routes/bill.routes");
const customerRoutes     = require("./routes/customer.routes");
const analyticsRoutes    = require("./routes/analytics.routes");
const notificationRoutes = require("./routes/notification.routes");
const categoriesRoutes   = require("./routes/categories.routes");

// ── Admin routes ──────────────────────────────────────────────
const adminClientRoutes    = require("./routes/admin/clients.admin.routes");
const adminInventoryRoutes = require("./routes/admin/inventory.admin.routes");
const adminReportsRoutes   = require("./routes/admin/reports.admin.routes");
const adminExportRoutes    = require("./routes/admin/export.admin.routes");
const adminOrderRoutes     = require("./routes/admin/orders.admin.routes");
const adminSearchRoutes    = require("./routes/admin/search.admin.routes");
const adminAuditRoutes     = require("./routes/admin/auditlog.admin.routes");
const adminAIRoutes        = require("./routes/admin/ai.admin.routes");
const adminNotifyRoutes    = require("./routes/admin/notify.admin.routes");
const adminDuplicateRoutes   = require("./routes/admin/duplicate.admin.routes");
const adminRolesRoutes       = require("./routes/admin/roles.admin.routes");
const adminBulkInvoiceRoutes = require("./routes/admin/bulk_invoice.admin.routes");
const adminReorderRoutes     = require("./routes/admin/reorder.admin.routes");
const adminCategoriesRoutes  = require("./routes/admin/categories.admin.routes");
const adminClientsImportRoutes = require("./routes/admin/clients.import.routes");
const adminBillRoutes = require("./routes/admin/bills.admin.routes");

const app = express();

// ── Connect DB + start scheduler ─────────────────────────────
connectDB().then(() => {
  require("./jobs/scheduler");
});

// ── Allowed origins ───────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "https://vyrelle.in",
  "https://www.vyrelle.in",
  "https://sanskriti.vyrelle.in",
  "https://www.sanskriti.vyrelle.in",
  process.env.FRONTEND_URL,
].filter(Boolean);

// ── Security ──────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", ...ALLOWED_ORIGINS], fontSrc: ["'self'", "https:", "data:"],
      objectSrc:  ["'none'"], upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods:     ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","X-Requested-With"],
  exposedHeaders: ["X-Total-Count"],
  maxAge: 86400,
}));

// ── Rate limiters ─────────────────────────────────────────────
app.use("/api/auth", rateLimit({ windowMs: 15*60*1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { success:false, message:"Too many login attempts." } }));
app.use("/api",      rateLimit({ windowMs: 60*1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { success:false, message:"Too many requests." } }));

// ── Razorpay webhook needs the RAW body for signature verification.
// Must be registered BEFORE express.json(), otherwise the body gets
// parsed/consumed first and signature verification will always fail.
const { webhook } = require("./controllers/paymentController");
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), webhook);

// ── Body parsers (everything else) ───────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// ── Static files ──────────────────────────────────────────────
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads"), {
  maxAge: "7d", etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".pdf")) { res.setHeader("Content-Disposition", "inline"); res.setHeader("Content-Type", "application/pdf"); }
  },
}));

// ── Health check ──────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString(), env: process.env.NODE_ENV, uptime: Math.floor(process.uptime()) + "s" });
});

// ── Existing routes ───────────────────────────────────────────
app.use("/api/auth",     authRoutes);
app.use("/api/seller",   sellerRoutes);
app.use("/api/wallet",   walletRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/payouts",  payoutRoutes);
app.use("/api/orders",   orderRoutes);
app.use("/api/bills",    billRoutes);
app.use("/api/customers",     customerRoutes);
app.use("/api/analytics",     analyticsRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/categories",    categoriesRoutes);

// ── Admin routes ──────────────────────────────────────────────
app.use("/api/admin/clients",    adminClientRoutes);
app.use("/api/admin/inventory",  adminInventoryRoutes);
app.use("/api/admin/reports",    adminReportsRoutes);
app.use("/api/admin/export",     adminExportRoutes);
app.use("/api/admin/orders",     adminOrderRoutes);
app.use("/api/admin/search",     adminSearchRoutes);
app.use("/api/admin/audit-logs", adminAuditRoutes);
app.use("/api/admin/ai",         adminAIRoutes);
app.use("/api/admin/notify",     adminNotifyRoutes);
app.use("/api/admin/refunds",    require("./routes/admin/refunds.admin.routes"));
app.use("/api/admin/returns", require("./routes/admin/returns.admin.routes"));
app.use("/api/admin/duplicates",    adminDuplicateRoutes);
app.use("/api/admin/roles",         adminRolesRoutes);
app.use("/api/admin/bulk-invoice",  adminBulkInvoiceRoutes);
app.use("/api/admin/reorder",       adminReorderRoutes);
app.use("/api/admin/categories",    adminCategoriesRoutes);
app.use("/api/admin/clients", adminClientsImportRoutes);
app.use("/api/admin/bills", adminBillRoutes);

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.message?.startsWith("CORS:")) return res.status(403).json({ success: false, message: err.message });
  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map(e => e.message);
    return res.status(400).json({ success: false, message: messages.join(". ") });
  }
  if (err.name === "JsonWebTokenError") return res.status(401).json({ success: false, message: "Invalid token" });
  if (err.name === "TokenExpiredError") return res.status(401).json({ success: false, message: "Token expired", code: "TOKEN_EXPIRED" });
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    return res.status(409).json({ success: false, message: `${field} already exists` });
  }
  console.error("[Error]", err.stack || err.message);
  res.status(err.status || 500).json({ success: false, message: process.env.NODE_ENV === "production" ? "Internal server error" : err.message });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT} [${process.env.NODE_ENV || "development"}]`);
});

module.exports = app;
