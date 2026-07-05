// ═══════════════════════════════════════════════════════════════
// FILE 2: src/routes/admin/roles.admin.routes.js
// Manager / Employee role management
// ═══════════════════════════════════════════════════════════════
const express  = require("express");
const router   = express.Router();
const bcrypt   = require("bcryptjs");
const Seller   = require("../../models/kyc.model");
const { logAction } = require("../../utils/audit");
const { protect, restrictTo } = require("../../middleware/auth.middleware");

router.use(protect, restrictTo("admin"));

const PERMISSIONS = {
  admin:    ["all"],
  manager:  ["orders", "clients", "inventory", "billing", "reports", "export", "search", "notifications"],
  employee: ["orders", "clients", "inventory", "search"],
};

// GET /api/admin/roles — list all staff
router.get("/", async (req, res) => {
  try {
    const staff = await Seller.find({ role: { $in: ["admin", "manager", "employee"] } })
      .select("name email phone role permissions status createdAt lastLogin")
      .lean();
    res.json({ success: true, staff });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/roles — create manager or employee
router.post("/", async (req, res) => {
  try {
    const { name, email, phone, password, role } = req.body;
    if (!["manager", "employee"].includes(role))
      return res.status(400).json({ success: false, message: "Role must be manager or employee" });
    if (!name || !email || !password)
      return res.status(400).json({ success: false, message: "Name, email and password are required" });

    const exists = await Seller.findOne({ email });
    if (exists) return res.status(409).json({ success: false, message: "Email already registered" });

    const hashed = await bcrypt.hash(password, 12);
    const staff  = await Seller.create({
      name, email, phone: phone || "",
      password: hashed,
      role,
      permissions: PERMISSIONS[role],
      status: "active",
      kycStatus: "approved",
      isEmailVerified: true,
    });

    await logAction(req, {
      action: "CREATE",
      entity: "Staff",
      entityId: staff._id,
      description: `Created ${role} account for ${name} (${email})`,
    });

    res.status(201).json({ success: true, message: `${role} account created`, staff: { _id: staff._id, name, email, role } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/admin/roles/:id — update role or permissions
router.patch("/:id", async (req, res) => {
  try {
    const { role, permissions, status } = req.body;
    const update = {};
    if (role && ["manager", "employee"].includes(role)) {
      update.role = role;
      update.permissions = PERMISSIONS[role];
    }
    if (permissions) update.permissions = permissions;
    if (status)      update.status = status;

    const staff = await Seller.findByIdAndUpdate(req.params.id, update, { new: true })
      .select("name email role permissions status");
    if (!staff) return res.status(404).json({ success: false, message: "Staff not found" });

    await logAction(req, {
      action: "UPDATE",
      entity: "Staff",
      entityId: staff._id,
      description: `Updated ${staff.name}: ${JSON.stringify(update)}`,
    });

    res.json({ success: true, staff });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/admin/roles/:id — remove staff account
router.delete("/:id", async (req, res) => {
  try {
    const staff = await Seller.findById(req.params.id);
    if (!staff) return res.status(404).json({ success: false, message: "Staff not found" });
    if (staff.role === "admin") return res.status(403).json({ success: false, message: "Cannot delete admin accounts" });

    await Seller.findByIdAndDelete(req.params.id);
    await logAction(req, {
      action: "DELETE",
      entity: "Staff",
      entityId: req.params.id,
      description: `Deleted ${staff.role} account: ${staff.name} (${staff.email})`,
    });

    res.json({ success: true, message: "Staff account deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/roles/:id/reset-password
router.post("/:id/reset-password", async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6)
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    const hashed = await bcrypt.hash(password, 12);
    await Seller.findByIdAndUpdate(req.params.id, { password: hashed });
    res.json({ success: true, message: "Password reset successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
