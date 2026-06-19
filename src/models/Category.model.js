const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },

    // Used as the "id" on the public gallery page (matches Product.category values)
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },

    // Small square thumbnail — shown in the "Choose the Category" grid
    image: { type: String, default: "" },

    // OPTIONAL wider/banner photo for the hero carousel slide. If empty,
    // the hero carousel just reuses `image`.
    heroImage: { type: String, default: "" },

    // Display text like "33+" shown under the category name
    count: { type: String, default: "" },

    // Order in the "Choose the Category" grid (lower = earlier)
    displayOrder: { type: Number, default: 0 },

    // Whether this category appears as a slide in the hero carousel
    showInHero: { type: Boolean, default: false },

    // Order within the hero carousel (lower = earlier), only relevant if showInHero
    heroOrder: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false }
);

categorySchema.index({ slug: 1 });
categorySchema.index({ isActive: 1, displayOrder: 1 });
categorySchema.index({ showInHero: 1, heroOrder: 1 });

module.exports = mongoose.model("Category", categorySchema);
