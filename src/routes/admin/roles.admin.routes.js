// ═══════════════════════════════════════════════════════════════
// FILE: src/routes/admin/roles.admin.routes.js
// Manager / Employee role management — Admin only
// ═══════════════════════════════════════════════════════════════
const express  = require("express");
const router   = express.Router();
const Staff    = require("../../models/Staff.model");
const { logAction } = require("../../utils/audit");
const { protectStaff, restrictStaffTo } = require("../../middleware/staffAuth.middleware");

router.use(protectStaff, restrictStaffTo("admin"));

// GET /api/admin/roles — list all staff
router.get("/", async (req, res) => {
  try {
    const staff = await Staff.find({})
      .select("name email phone role status createdAt")
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

    const exists = await Staff.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ success: false, message: "Email already registered" });

    // passwordHash is hashed automatically by the Staff model's pre-save hook
    const staff = await Staff.create({
      name,
      email,
      phone: phone || "",
      passwordHash: password,
      role,
      status: "active",
    });

    await logAction(req, {
      action: "CREATE",
      entity: "Staff",
      entityId: staff._id,
      description: `Created ${role} account for ${name} (${email})`,
    });

    res.status(201).json({
      success: true,
      message: `${role} account created`,
      staff: { _id: staff._id, name, email, role },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/admin/roles/:id — update role or status
router.patch("/:id", async (req, res) => {
  try {
    const { role, status } = req.body;
    const update = {};
    if (role && ["manager", "employee"].includes(role)) update.role = role;
    if (status) update.status = status;

    const staff = await Staff.findByIdAndUpdate(req.params.id, update, { new: true })
      .select("name email role status");
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
    const staff = await Staff.findById(req.params.id);
    if (!staff) return res.status(404).json({ success: false, message: "Staff not found" });
    if (staff.role === "admin") return res.status(403).json({ success: false, message: "Cannot delete admin accounts" });

    await Staff.findByIdAndDelete(req.params.id);
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

    const staff = await Staff.findById(req.params.id).select("+passwordHash");
    if (!staff) return res.status(404).json({ success: false, message: "Staff not found" });

    staff.passwordHash = password; // pre-save hook re-hashes it
    await staff.save();

    res.json({ success: true, message: "Password reset successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
