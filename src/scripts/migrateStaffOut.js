const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const mongoose = require("mongoose");
require("dotenv").config();

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);

  const Seller = require("../models/Seller.model");
  const staffCollection = mongoose.connection.db.collection("staff");

  const staffAccounts = await Seller.find({ role: { $in: ["admin", "manager", "employee"] } })
    .select("+passwordHash")
    .lean();

  let migrated = 0;
  for (const s of staffAccounts) {
    const exists = await staffCollection.findOne({ email: s.email });
    if (exists) {
      console.log(`Skipping ${s.email}, already migrated.`);
      continue;
    }

    await staffCollection.insertOne({
      name: s.name,
      email: s.email,
      phone: s.phone,
      passwordHash: s.passwordHash, // already bcrypt-hashed — inserted raw, bypasses the pre-save hook so it won't be double-hashed
      role: s.role,
      status: s.status === "suspended" ? "suspended" : "active",
      createdAt: s.createdAt || new Date(),
      updatedAt: new Date(),
    });
    migrated++;
  }

  console.log(`Migrated ${migrated} staff account(s) into 'staff' collection.`);
  console.log("Verify the 'staff' collection before deleting anything from 'sellers'.");
  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
