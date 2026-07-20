const express  = require("express");
const router   = express.Router();

const Category = require("../../models/Category.model");
const { protectStaff, restrictStaffTo } = require("../../middleware/staffAuth.middleware");
const { logAction } = require("../../utils/audit");
const { uploadCategoryImages } = require("../../middleware/upload.middleware");

// All category admin routes require login + admin role
router.use(protectStaff, restrictStaffTo("admin"));

// ── GET /api/admin/categories ─────────────────────────────────
// Every category (active + inactive), sorted for the admin table
router.get("/", async (req, res) => {
  try {
    const categories = await Category.find().sort({ displayOrder: 1 }).lean();
    res.json({ success: true, categories });
  } catch (err) {
    console.error("[admin/categories list]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/admin/categories/:id ─────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const category = await Category.findById(req.params.id).lean();
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });
    res.json({ success: true, category });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /api/admin/categories ────────────────────────────────
// multipart/form-data fields: label, slug, count, displayOrder,
// showInHero, heroOrder, isActive, image (file), heroImage (file)
router.post("/", uploadCategoryImages, async (req, res) => {
  try {
    const { label, slug, count, displayOrder, showInHero, heroOrder, isActive } = req.body;

    if (!label || !slug) {
      return res.status(400).json({ success: false, message: "Label and slug are required" });
    }

    const cleanSlug = slug.toLowerCase().trim();
    const exists = await Category.findOne({ slug: cleanSlug });
    if (exists) {
      return res.status(409).json({ success: false, message: "A category with this slug already exists" });
    }

    const category = await Category.create({
      label: label.trim(),
      slug: cleanSlug,
      count: count || "",
      displayOrder: Number(displayOrder) || 0,
      heroOrder: Number(heroOrder) || 0,
      showInHero: showInHero === "true" || showInHero === true,
      isActive: isActive === undefined ? true : (isActive === "true" || isActive === true),
      image: req.files?.image?.[0] ? `/uploads/categories/${req.files.image[0].filename}` : "",
      heroImage: req.files?.heroImage?.[0] ? `/uploads/categories/${req.files.heroImage[0].filename}` : "",
    });

    await logAction(req, {
      action: "CREATE",
      entity: "Category",
      entityId: category._id,
      description: `Created category "${category.label}" (${category.slug})`,
    });

    res.status(201).json({ success: true, message: "Category created", category });
  } catch (err) {
    console.error("[admin/categories create]", err);
    res.status(500).json({ success: false, message: err.message || "Server error" });
  }
});

// ── PATCH /api/admin/categories/:id ───────────────────────────
// Same fields as POST, all optional — only what's sent gets updated.
// Re-uploading image/heroImage replaces the old file reference (old
// file on disk is left as-is to keep this simple/safe).
router.patch("/:id", uploadCategoryImages, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });

    const { label, slug, count, displayOrder, showInHero, heroOrder, isActive } = req.body;

    if (slug !== undefined) {
      const cleanSlug = slug.toLowerCase().trim();
      if (cleanSlug !== category.slug) {
        const exists = await Category.findOne({ slug: cleanSlug, _id: { $ne: category._id } });
        if (exists) return res.status(409).json({ success: false, message: "A category with this slug already exists" });
        category.slug = cleanSlug;
      }
    }

    if (label !== undefined)        category.label = label.trim();
    if (count !== undefined)        category.count = count;
    if (displayOrder !== undefined) category.displayOrder = Number(displayOrder) || 0;
    if (heroOrder !== undefined)    category.heroOrder = Number(heroOrder) || 0;
    if (showInHero !== undefined)   category.showInHero = showInHero === "true" || showInHero === true;
    if (isActive !== undefined)     category.isActive = isActive === "true" || isActive === true;

    if (req.files?.image?.[0])     category.image     = `/uploads/categories/${req.files.image[0].filename}`;
    if (req.files?.heroImage?.[0]) category.heroImage = `/uploads/categories/${req.files.heroImage[0].filename}`;

    await category.save();

    await logAction(req, {
      action: "UPDATE",
      entity: "Category",
      entityId: category._id,
      description: `Updated category "${category.label}" (${category.slug})`,
    });

    res.json({ success: true, message: "Category updated", category });
  } catch (err) {
    console.error("[admin/categories update]", err);
    res.status(500).json({ success: false, message: err.message || "Server error" });
  }
});

// ── DELETE /api/admin/categories/:id ──────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });

    await logAction(req, {
      action: "DELETE",
      entity: "Category",
      entityId: category._id,
      description: `Deleted category "${category.label}" (${category.slug})`,
    });

    res.json({ success: true, message: "Category deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
