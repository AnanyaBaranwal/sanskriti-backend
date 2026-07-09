const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Create uploads folder if it doesn't exist
const uploadDir = "uploads/";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const kycDir = "uploads/kyc/";
if (!fs.existsSync(kycDir)) {
  fs.mkdirSync(kycDir, { recursive: true });
}

const profileDir = "uploads/profile/";
if (!fs.existsSync(profileDir)) {
  fs.mkdirSync(profileDir, { recursive: true });
}

const categoryDir = "uploads/categories/";
if (!fs.existsSync(categoryDir)) {
  fs.mkdirSync(categoryDir, { recursive: true });
}

// Storage config for KYC documents — seller's own upload (kyc/upload, protect middleware sets req.seller)
const kycStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/kyc/");
  },
  filename: (req, file, cb) => {
    // Format: sellerID_fieldname_timestamp.ext
    const ext = path.extname(file.originalname);
    const filename = `${req.seller.id}_${file.fieldname}_${Date.now()}${ext}`;
    cb(null, filename);
  },
});

// Storage config for KYC documents uploaded BY AN ADMIN on behalf of a seller.
// Filenames use req.params.id (the target seller), not req.seller.id (the
// logged-in admin) — otherwise every admin-uploaded file would be misnamed
// with the admin's own account id.
const kycAdminStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/kyc/");
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `${req.params.id}_${file.fieldname}_${Date.now()}${ext}`;
    cb(null, filename);
  },
});

// Storage config for profile photos
const profileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/profile/");
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `${req.seller.id}_profile_${Date.now()}${ext}`;
    cb(null, filename);
  },
});

// Storage config for category images (grid thumbnail + optional hero banner)
const categoryStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/categories/");
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `${file.fieldname}_${Date.now()}_${Math.round(Math.random() * 1e6)}${ext}`;
    cb(null, filename);
  },
});

// File filter — only allow images and PDFs
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|pdf/;
  const extname = allowedTypes.test(
    path.extname(file.originalname).toLowerCase()
  );
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error("Only JPG, PNG, and PDF files are allowed"), false);
  }
};

// KYC upload (seller's own) — accepts multiple fields
exports.uploadKYC = multer({
  storage: kycStorage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
}).fields([
  { name: "panDocument", maxCount: 1 },
  { name: "aadharDocument", maxCount: 1 },
  { name: "cancelledCheque", maxCount: 1 },
]);

// KYC upload performed BY AN ADMIN on behalf of a seller
exports.uploadKYCAdmin = multer({
  storage: kycAdminStorage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
}).fields([
  { name: "panDocument", maxCount: 1 },
  { name: "aadharDocument", maxCount: 1 },
  { name: "cancelledCheque", maxCount: 1 },
]);

// Profile photo upload — single file
exports.uploadProfile = multer({
  storage: profileStorage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
}).single("profilePhoto");

// Category image upload — optional grid thumbnail + optional hero banner
exports.uploadCategoryImages = multer({
  storage: categoryStorage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB max per file
}).fields([
  { name: "image", maxCount: 1 },
  { name: "heroImage", maxCount: 1 },
]);
