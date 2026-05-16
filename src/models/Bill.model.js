const mongoose = require("mongoose");

const billSchema = new mongoose.Schema(
  {
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      required: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    invoiceNumber: {
      type: String,
      unique: true,
    },
    buyer: {
      name: { type: String, required: true },
      phone: String,
      email: String,
      address: {
        street: String,
        city: String,
        state: String,
        pincode: String,
      },
    },
    seller: {
      name: String,
      businessName: String,
      email: String,
      phone: String,
      gstNumber: String,
      address: {
        street: String,
        city: String,
        state: String,
        pincode: String,
      },
    },
    items: [
      {
        name: String,
        description: String,
        quantity: Number,
        price: Number,
        total: Number,
        gstRate: { type: Number, default: 0 },
        gstAmount: { type: Number, default: 0 },
      },
    ],
    subtotal: { type: Number, required: true },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    grandTotal: { type: Number, required: true },
    paymentMethod: String,
    paymentStatus: {
      type: String,
      enum: ["PAID", "UNPAID", "PARTIAL"],
      default: "UNPAID",
    },
    notes: String,
    pdfUrl: String,
    isIntraState: { type: Boolean, default: true }, // same state = CGST+SGST, different = IGST
  },
  { timestamps: true }
);

// Auto generate invoice number
billSchema.pre("save", async function (next) {
  if (!this.invoiceNumber) {
    const count = await mongoose.model("Bill").countDocuments();
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    this.invoiceNumber = `INV-${year}${month}-${String(count + 1).padStart(4, "0")}`;
  }
  next();
});

billSchema.index({ sellerId: 1, createdAt: -1 });
billSchema.index({ orderId: 1 });

module.exports = mongoose.model("Bill", billSchema);
