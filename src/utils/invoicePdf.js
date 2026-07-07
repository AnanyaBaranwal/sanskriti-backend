const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const fs   = require("fs");
const path = require("path");

const DARK  = rgb(0.10, 0.06, 0.04);
const GRAY  = rgb(0.45, 0.45, 0.45);
const LINE  = rgb(0.85, 0.85, 0.85);
const LIGHT = rgb(0.97, 0.97, 0.97);
const GOLD  = rgb(0.79, 0.66, 0.30);

exports.ensureBillsDir = () => {
  const dir = path.join(process.cwd(), "uploads", "bills");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

exports.generateInvoicePDF = async (bill) => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold    = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595;
  let Y = 800;

  const text = (t, x, y, opts = {}) =>
    page.drawText(String(t ?? ""), { x, y, size: opts.size || 9, font: opts.bold ? bold : regular, color: opts.color || DARK });

  text("Sanskriti", W/2 - 30, Y, { size: 16, bold: true, color: GOLD });
  Y -= 34;
  text("INVOICE", W/2 - 40, Y, { size: 22, bold: true });
  Y -= 26;

  page.drawRectangle({ x: 30, y: Y-30, width: W-60, height: 34, color: LIGHT });
  text("INVOICE NUMBER", 40, Y-10, { size: 7.5, color: GRAY });
  text(bill.invoiceNumber, 40, Y-22, { size: 11, bold: true });
  text("INVOICE DATE", W-160, Y-10, { size: 7.5, color: GRAY });
  text(new Date(bill.invoiceDate || bill.createdAt).toLocaleDateString("en-GB"), W-160, Y-22, { size: 11, bold: true });
  Y -= 48;

  text("BILL TO", 30, Y, { size: 11, bold: true });
  Y -= 10;
  page.drawLine({ start: {x:30,y:Y}, end:{x:W-30,y:Y}, thickness: 1, color: DARK });
  Y -= 16;

  const col2 = 320;
  const rowH = 30;
  const fields = [
    ["NAME", bill.buyer?.name, "EMAIL", bill.buyer?.email],
    ["PHONE", bill.buyer?.phone, "GST NUMBER", bill.buyer?.gstNumber],
    ["STATE", bill.buyer?.state, "PIN CODE", bill.buyer?.pincode],
  ];
  fields.forEach(([l1,v1,l2,v2]) => {
    text(l1, 30, Y, { size: 7.5, color: GRAY }); text(v1, 30, Y-13, { size: 10 });
    text(l2, col2, Y, { size: 7.5, color: GRAY }); text(v2, col2, Y-13, { size: 10 });
    Y -= rowH;
  });
  text("ADDRESS", 30, Y, { size: 7.5, color: GRAY });
  text(bill.buyer?.address || "", 30, Y-13, { size: 9.5 });
  Y -= 40;

  text("PRODUCT DETAILS", 30, Y, { size: 11, bold: true });
  Y -= 18;
  page.drawRectangle({ x:30, y:Y-16, width:W-60, height:18, color: LIGHT });
  text("PRODUCT", 38, Y-11, { size: 8, bold: true, color: GRAY });
  text("SKU", 340, Y-11, { size: 8, bold: true, color: GRAY });
  text("QTY", 420, Y-11, { size: 8, bold: true, color: GRAY });
  text("PRICE", 455, Y-11, { size: 8, bold: true, color: GRAY });
  text("AMOUNT", 505, Y-11, { size: 8, bold: true, color: GRAY });
  Y -= 20;

  (bill.items || []).forEach(item => {
    const name = item.name.length > 42 ? item.name.slice(0,42)+"..." : item.name;
    text(name, 38, Y, { size: 9 });
    text(item.sku || "—", 340, Y, { size: 9 });
    text(String(item.quantity || 1), 425, Y, { size: 9 });
    text(`₹${item.price.toFixed(2)}`, 455, Y, { size: 9 });
    text(`₹${item.amount.toFixed(2)}`, 505, Y, { size: 9 });
    Y -= 20;
  });

  Y -= 10;
  page.drawLine({ start:{x:30,y:Y}, end:{x:W-30,y:Y}, thickness:0.5, color: LINE });
  Y -= 18;

  const summaryRow = (label, value, boldRow=false) => {
    text(label, 40, Y, { size: boldRow?11:9.5, bold: boldRow });
    text(value, W-140, Y, { size: boldRow?11:9.5, bold: boldRow });
    Y -= boldRow ? 22 : 18;
  };
  summaryRow("Subtotal:", `₹${bill.subtotal.toFixed(2)}`);
  summaryRow("Shipping Charge:", `₹${(bill.shippingCharge||0).toFixed(2)}`);
  summaryRow("Packaging Charge:", `₹${(bill.packagingCharge||0).toFixed(2)}`);
  summaryRow(`Tax (${bill.taxPercent}%):`, `₹${(bill.taxAmount||0).toFixed(2)}`);
  Y -= 6;
  page.drawLine({ start:{x:30,y:Y}, end:{x:W-30,y:Y}, thickness:1, color: DARK });
  Y -= 20;
  summaryRow("TOTAL PAYABLE:", `₹${bill.grandTotal.toFixed(2)} ${bill.currency}`, true);
  Y -= 14;

  page.drawRectangle({ x:30, y:Y-32, width:W-60, height:34, color: DARK });
  text("PAYMENT MODE", W/2-40, Y-10, { size: 7.5, color: GOLD });
  text(bill.paymentMode || "—", W/2-45, Y-24, { size: 11, bold: true, color: rgb(1,1,1) });
  Y -= 56;

  page.drawLine({ start:{x:30,y:Y}, end:{x:W-30,y:Y}, thickness:0.5, color: LINE });
  Y -= 16;
  text("Terms & Conditions", 30, Y, { size: 9.5, bold: true });
  text("Company Details", W-160, Y, { size: 9.5, bold: true });
  Y -= 14;
  ["Online download only. No physical delivery.",
   "Goods once sold will not be taken back or exchanged.",
   "Seller is not responsible for any loss or damage of goods in transit."]
   .forEach(line => { text(`• ${line}`, 30, Y, { size: 7.5, color: GRAY }); Y -= 12; });

  text("Company PAN: AUSPG5917A", W-190, Y+38, { size: 7.5, color: GRAY });
  text("Company GSTIN/UIN: 07AUSPG5917A1ZO", W-190, Y+26, { size: 7.5, color: GRAY });

  return await doc.save();
};