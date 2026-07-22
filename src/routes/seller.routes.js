const express = require("express");
const router = express.Router();
const {
  getProfile,
  updateProfile,
  updateBusiness,
  changePassword,
  getEligibility, // ← ADD
} = require("../controllers/sellerController");
const { getKYC, uploadKYC, deleteKycDocument } = require("../controllers/kycController"); // ← deleteKycDocument added
const { protect } = require("../middleware/auth.middleware");
const { uploadKYC: uploadKYCMiddleware } = require("../middleware/upload.middleware");

// All seller routes require login
router.use(protect);

router.get("/profile", getProfile);
router.patch("/profile", updateProfile);
router.patch("/business", updateBusiness);
router.get("/kyc", getKYC);
router.post("/kyc/upload", uploadKYCMiddleware, uploadKYC);
router.delete("/kyc/document/:docType", deleteKycDocument); // ← ADD
router.get("/eligibility", getEligibility); // ← ADD — used to proactively gate wallet recharge / order placement
router.patch("/change-password", changePassword);

module.exports = router;
