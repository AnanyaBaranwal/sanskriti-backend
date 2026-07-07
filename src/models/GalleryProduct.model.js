const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// GalleryProduct = the master catalog Sanskriti maintains. Sellers browse this
// (the "Gallery" website) and place a GalleryOrder against items in it.
// costPrice is the PURE cost price — no margin, packaging, shipping or GST
// added. This is intentionally a separate collection from `Product` (which is
// a seller's own inventory) so the two catalogs never collide.
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: categories are NOT a fixed list — the admin panel creates them
// on the fly by simply typing a category name when adding a product.
// The gallery starts completely empty; nothing is seeded.
const CONDITIONS = ["Excellent", "Good", "Fair", "Restoration Needed"];

const galleryProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, trim: true, uppercase: true },

    category: { type: String, trim: true, default: "" }, // admin-defined, free text
    origin: { type: String, trim: true }, // e.g. "West Bengal · 100 yrs"
    condition: { type: String, enum: CONDITIONS, default: "Good" },
    description: { type: String, trim: true },

    images: { type: [String], default: [] }, // first image = cover
    imageUrl: { type: String, default: "" }, // convenience cover field

    // ── Pricing ──────────────────────────────────────────────────────────
    // costPrice = exactly what the seller is charged (wallet debited this
    // amount per unit on approval). No markup is ever added on top of this.
    costPrice: { type: Number, required: true, min: 0 },
    // mrp is informational only (shown as a struck-through reference value),
    // never charged to the seller.
    mrp: { type: Number, default: 0 },

    // ── Stock ────────────────────────────────────────────────────────────
    stockQty: { type: Number, default: 0, min: 0 },
    inStock: { type: Boolean, default: true },
    totalOrdered: { type: Number, default: 0 }, // cumulative units ordered by sellers

    // Free-text ribbon badge admin can set, e.g. "Bestseller", "New Launch",
    // "Popular", "Heritage" — purely a merchandising label, no fixed list.
    tag: { type: String, trim: true, default: "" },

    featured: { type: Boolean, default: false },
    certificate: { type: Boolean, default: false },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

galleryProductSchema.index({ name: "text", sku: "text", category: "text", origin: "text" });
galleryProductSchema.index({ category: 1, isActive: 1 });
galleryProductSchema.index({ featured: 1 });

galleryProductSchema.virtual("cover").get(function () {
  return this.imageUrl || this.images?.[0] || "";
});
galleryProductSchema.set("toJSON", { virtuals: true });
galleryProductSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("GalleryProduct", galleryProductSchema);
module.exports.CONDITIONS = CONDITIONS;
