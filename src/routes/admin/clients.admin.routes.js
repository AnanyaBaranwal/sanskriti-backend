const express = require("express");
const router  = express.Router();
const mongoose = require("mongoose");

const Client  = require("../../models/Client.model");
const Order   = require("../../models/Order.model");
const { protect, restrictTo } = require("../../middleware/auth.middleware");
const { logAction } = require("../../utils/audit");

// All client admin routes require login + admin role
router.use(protect, restrictTo("admin"));

// ── GET /api/admin/clients ────────────────────────────────────
// List all clients with search + filter, plus summary stats for
// the header cards (Total / Active / With GST).
router.get("/", async (req, res) => {
  try {
    const {
      search, state, city, status,
      page = 1, limit = 20,
      sortBy = "lastOrderAt", sortDir = "desc",
    } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { name:      { $regex: search, $options: "i" } },
        { phone:     { $regex: search, $options: "i" } },
        { email:     { $regex: search, $options: "i" } },
        { company:   { $regex: search, $options: "i" } },
        { gstNumber: { $regex: search, $options: "i" } },
      ];
    }
    if (state)  query["address.state"] = { $regex: state, $options: "i" };
    if (city)   query["address.city"]  = { $regex: city,  $options: "i" };
    if (status) query.status = status;

    const total    = await Client.countDocuments(query);
    const active   = await Client.countDocuments({ ...query, status: "active" });
    const withGST  = await Client.countDocuments({ ...query, gstNumber: { $exists: true, $nin: [null, ""] } });

    const clients = await Client.find(query)
      .sort({ [sortBy]: sortDir === "asc" ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean({ virtuals: true });

    res.json({
      success: true,
      total,
      page: Number(page),
      pages: Math.ceil(total / limit),
      stats: { total, active, withGST },
      clients,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /api/admin/clients ───────────────────────────────────
// Manually add a new client (User Management "+ Add Client" button)
router.post("/", async (req, res) => {
  try {
    const { name, phone, email, company, gstNumber, address, walletBalance, status, role } = req.body;

    if (!name?.trim() || !phone?.trim()) {
      return res.status(400).json({ success: false, message: "Name and phone are required" });
    }

    const exists = await Client.findOne({ sellerId: req.seller.id, phone: phone.trim() });
    if (exists) {
      return res.status(409).json({ success: false, message: "A client with this phone number already exists" });
    }

    const client = await Client.create({
      sellerId: req.seller.id,
      name:  name.trim(),
      phone: phone.trim(),
      email: email?.trim() || null,
      company:   company?.trim()   || "",
      gstNumber: gstNumber?.trim() || "",
      address: address || {},
      walletBalance: Number(walletBalance) || 0,
      status: ["active", "inactive"].includes(status) ? status : "active",
      role:   ["customer", "wholesale", "vip"].includes(role) ? role : "customer",
    });

    await logAction(req, {
      action:      "CREATE",
      entity:      "Client",
      entityId:    client._id,
      entityRef:   client.name,
      description: `Manually added client ${client.name}`,
    });

    res.status(201).json({ success: true, client });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/clients/:id ────────────────────────────────
// Full client dashboard
router.get("/:id", async (req, res) => {
  try {
    const client = await Client.findById(req.params.id).lean({ virtuals: true });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    // Recent 10 orders
    const recentOrders = await Order.find({ clientId: req.params.id })
      .sort({ createdAt: -1 })
      .limit(10)
      .select("orderNumber status total paymentStatus createdAt items")
      .lean();

    res.json({ success: true, client: { ...client, recentOrders } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /api/admin/clients/:id/notes ─────────────────────────
// Add an internal note to a client
router.post("/:id/notes", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) {
      return res.status(400).json({ success: false, message: "Note text is required" });
    }

    const client = await Client.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          notes: {
            text:        text.trim(),
            addedBy:     req.seller.id,
            addedByName: req.seller.name || null,
          },
        },
      },
      { new: true }
    );

    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    await logAction(req, {
      action:      "CREATE",
      entity:      "Client",
      entityId:    client._id,
      entityRef:   client.name,
      description: `Added internal note to client ${client.name}`,
    });

    res.json({ success: true, notes: client.notes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── DELETE /api/admin/clients/:id/notes/:noteId ───────────────
router.delete("/:id/notes/:noteId", async (req, res) => {
  try {
    const client = await Client.findByIdAndUpdate(
      req.params.id,
      { $pull: { notes: { _id: req.params.noteId } } },
      { new: true }
    );
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });
    res.json({ success: true, notes: client.notes });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/clients/:id/activity ──────────────────────
// Client activity history = all their orders as a timeline
router.get("/:id/activity", async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const total = await Order.countDocuments({ clientId: req.params.id });
    const orders = await Order.find({ clientId: req.params.id })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .select("orderNumber status total paymentStatus createdAt statusHistory items")
      .lean();

    res.json({
      success: true,
      total,
      page: Number(page),
      pages: Math.ceil(total / limit),
      activity: orders,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/admin/clients/:id ──────────────────────────────
// Update client info — now includes company, GST, wallet balance,
// status, and role so the drawer can fully edit a client record.
router.patch("/:id", async (req, res) => {
  try {
    const allowed = ["name", "email", "address", "company", "gstNumber", "walletBalance", "status", "role"];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    const before = await Client.findById(req.params.id).lean();
    const client = await Client.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    await logAction(req, {
      action:      "UPDATE",
      entity:      "Client",
      entityId:    client._id,
      entityRef:   client.name,
      description: `Updated client info for ${client.name}`,
      before:      before,
      after:       updates,
    });

    res.json({ success: true, client });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── DELETE /api/admin/clients/:id ─────────────────────────────
// Remove a client record entirely (does not touch past orders)
router.delete("/:id", async (req, res) => {
  try {
    const client = await Client.findByIdAndDelete(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    await logAction(req, {
      action:      "DELETE",
      entity:      "Client",
      entityId:    req.params.id,
      entityRef:   client.name,
      description: `Deleted client ${client.name}`,
    });

    res.json({ success: true, message: "Client deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
