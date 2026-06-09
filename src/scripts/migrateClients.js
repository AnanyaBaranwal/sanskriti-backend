/**
 * Migration: backfill Client collection from existing orders
 *
 * Run ONCE from your backend folder:
 *   node src/scripts/migrateClients.js
 *
 * What it does:
 *   1. Reads every existing Order
 *   2. Creates a Client doc per unique (sellerId + buyer.phone)
 *   3. Sets totalOrders, totalRevenue, returnedOrders, lastOrderAt on each client
 *   4. Writes clientId back onto each Order document
 *
 * Safe to re-run — uses upsert so no duplicates created.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");

const Order  = require("../models/Order.model");
const Client = require("../models/Client.model");

const run = async () => {
  await connectDB();
  console.log("✅ Connected to DB");

  const orders = await Order.find({}).lean();
  console.log(`📦 Found ${orders.length} orders to process`);

  let created = 0;
  let updated = 0;
  let linked  = 0;
  let errors  = 0;

  for (const order of orders) {
    try {
      if (!order.buyer?.phone) {
        console.warn(`⚠️  Order ${order.orderNumber} has no buyer phone — skipping`);
        continue;
      }

      // Upsert client by sellerId + phone
      const client = await Client.findOneAndUpdate(
        { sellerId: order.sellerId, phone: order.buyer.phone },
        {
          $setOnInsert: {
            sellerId: order.sellerId,
            name:     order.buyer.name  || "Unknown",
            phone:    order.buyer.phone,
            email:    order.buyer.email || null,
            address:  order.buyer.address || {},
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      if (client.wasNew) created++;
      else updated++;

      // Write clientId back to the order (only if not already set)
      if (!order.clientId) {
        await Order.findByIdAndUpdate(order._id, { clientId: client._id });
        linked++;
      }
    } catch (err) {
      console.error(`❌ Error on order ${order.orderNumber}:`, err.message);
      errors++;
    }
  }

  // Now recalculate stats for every client
  console.log("\n📊 Recalculating stats for all clients...");
  const clients = await Client.find({}).lean();

  for (const client of clients) {
    const clientOrders = await Order.find({ clientId: client._id }).lean();

    const totalOrders    = clientOrders.length;
    const totalRevenue   = clientOrders.reduce((sum, o) => sum + (o.total || 0), 0);
    const returnedOrders = clientOrders.filter(o => o.status === "RETURNED").length;
    const lastOrder      = clientOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

    await Client.findByIdAndUpdate(client._id, {
      totalOrders,
      totalRevenue,
      returnedOrders,
      lastOrderAt: lastOrder?.createdAt || null,
    });
  }

  console.log("\n─────────────────────────────────");
  console.log(`✅ Migration complete`);
  console.log(`   Clients created : ${created}`);
  console.log(`   Clients updated : ${updated}`);
  console.log(`   Orders linked   : ${linked}`);
  console.log(`   Errors          : ${errors}`);
  console.log("─────────────────────────────────\n");

  await mongoose.disconnect();
  process.exit(0);
};

run().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
