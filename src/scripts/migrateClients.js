require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const Seller = require("../src/models/Seller.model");

  const clients = await Seller.find({ passwordHash: { $exists: false } });
  let i = await Seller.countDocuments({ sellerId: { $exists: true } });

  for (const c of clients) {
    if (!c.passwordHash) c.passwordHash = await bcrypt.hash("ChangeMe123!", 12);
    if (!["seller","admin","manager","employee"].includes(c.role)) c.role = "seller";
    if (!c.sellerId) { i++; c.sellerId = `SEL-${String(i).padStart(4, "0")}`; }
    await c.save({ validateBeforeSave: false });
  }
  console.log(`Migrated ${clients.length} clients`);
  process.exit(0);
})();