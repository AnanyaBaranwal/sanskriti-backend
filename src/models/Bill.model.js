const mongoose = require("mongoose");

const billItemSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  sku:      { type: String },
  quantity: { type: Number, default: 1 },
  price:    { type: Number, required: true },
  amount:   { type: Number, required: true },
}, { _id: false });

const billSchema = new mongoose.Schema(
  {
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: false, // admin-created manual bills have no linked order
    },
    invoiceNumber: { type: String, unique: true },
    transactionId: { type: String, unique: true, sparse: true },
    invoiceDate:   { type: Date, default: Date.now },

    // "BILL TO" block — snapshot of the seller/company at bill creation time
    buyer: {
      name:      { type: String, required: true }, // company / business name
      email:     String,
      phone:     String,
      gstNumber: String,
      state:     String,
      pincode:   String,
      address:   String,
    },

    items: [billItemSchema],

    subtotal:        { type: Number, required: true },
    shippingCharge:  { type: Number, default: 0 },
    packagingCharge: { type: Number, default: 0 },
    taxPercent:      { type: Number, default: 18 },
    taxAmount:       { type: Number, default: 0 },
    grandTotal:      { type: Number, required: true }, // TOTAL PAYABLE
    currency:        { type: String, default: "INR" },

    paymentMode:   { type: String, default: "Razorpay Wallet" },
    paymentStatus: { type: String, enum: ["PAID","UNPAID","PARTIAL"], default: "UNPAID" },

    pdfUrl: String,
  },
  { timestamps: true }
);

// Auto-generate invoice number (STA prefix) + transaction ID if not supplied
billSchema.pre("save", async function (next) {
  if (!this.invoiceNumber) {
    const count = await mongoose.model("Bill").countDocuments();
    this.invoiceNumber = `STA${3400 + count + 1}`;
  }
  if (!this.transactionId) {
    const r = () => Math.random().toString(36).slice(2, 10);
    this.transactionId = `TXN-${r()}-${r().toUpperCase()}`;
  }
  next();
});

billSchema.index({ sellerId: 1, createdAt: -1 });

module.exports = mongoose.model("Bill", billSchema);