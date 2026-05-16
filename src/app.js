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

const app = express();

// ── Connect database ──────────────────────────────────────────
connectDB();

// ── Allowed origins ───────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "https://sanskriti.vyrelle.in",
  "https://www.sanskriti.vyrelle.in",
  process.env.FRONTEND_URL,
].filter(Boolean);

// ── Security headers (Helmet) ─────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],  // needed for some payment SDKs
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", "data:", "blob:", "https:"],
      connectSrc:  ["'self'", ...ALLOWED_ORIGINS],
      fontSrc:     ["'self'", "https:", "data:"],
      objectSrc:   ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false, // allow Razorpay iframes
}));

// ── CORS hardening ────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, curl)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods:     ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","X-Requested-With"],
  exposedHeaders: ["X-Total-Count"],
  maxAge: 86400, // 24 hours preflight cache
}));

// ── Global rate limiters ──────────────────────────────────────
// Auth routes — strict
const authLimiter = rateLimit({
  windowMs:          15 * 60 * 1000,  // 15 min
  max:               10,
  standardHeaders:   true,
  legacyHeaders:     false,
  skipSuccessfulRequests: false,
  message: { success:false, message:"Too many login attempts. Try again in 15 minutes." },
});

// General API — lenient
const apiLimiter = rateLimit({
  windowMs:        60 * 1000,   // 1 min
  max:             120,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success:false, message:"Too many requests. Please slow down." },
});

// Upload routes — medium
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      20,
  message:  { success:false, message:"Upload rate limit reached." },
});

// Apply rate limits
app.use("/api/auth",          authLimiter);
app.use("/api",               apiLimiter);

// ── Body parsers ──────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// ── Static files ──────────────────────────────────────────────
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads"), {
  maxAge:    "7d",         // cache static files for 7 days
  etag:      true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".pdf")) {
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Content-Type", "application/pdf");
    }
  },
}));

// ── Health check ──────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:    "healthy",
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV,
    uptime:    Math.floor(process.uptime()) + "s",
  });
});

// ── API routes ────────────────────────────────────────────────
app.use("/api/auth",     authRoutes);
app.use("/api/seller",   sellerRoutes);
app.use("/api/wallet",   walletRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/payouts",  payoutRoutes);
app.use("/api/orders",   orderRoutes);
app.use("/api/bills",    billRoutes);

// ── 404 handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success:false, message:`Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  // CORS error
  if (err.message?.startsWith("CORS:")) {
    return res.status(403).json({ success:false, message:err.message });
  }
  // Validation errors
  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map(e => e.message);
    return res.status(400).json({ success:false, message:messages.join(". ") });
  }
  // JWT errors
  if (err.name === "JsonWebTokenError") {
    return res.status(401).json({ success:false, message:"Invalid token" });
  }
  if (err.name === "TokenExpiredError") {
    return res.status(401).json({ success:false, message:"Token expired", code:"TOKEN_EXPIRED" });
  }
  // Duplicate key (MongoDB)
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    return res.status(409).json({ success:false, message:`${field} already exists` });
  }
  console.error("[Error]", err.stack || err.message);
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
  });
});

// ── Start server ──────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT} [${process.env.NODE_ENV||"development"}]`);
});

module.exports = app;
