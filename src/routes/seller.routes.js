const express = require("express");
const router = express.Router();
const {
  getProfile,
  updateProfile,
  updateBusiness,
  getKYC,
  uploadKYC,
  changePassword,
} = require("../controllers/sellerController");
const { protect } = require("../middleware/auth.middleware");
const {
  uploadKYC: uploadKYCMiddleware,
  uploadProfile,
} = require("../middleware/upload.middleware");

// All seller routes require login
router.use(protect);

router.get("/profile", getProfile);
router.patch("/profile", uploadProfile, updateProfile);
router.patch("/business", updateBusiness);
router.get("/kyc", getKYC);
router.post("/kyc/upload", uploadKYCMiddleware, uploadKYC);
router.patch("/change-password", changePassword);

module.exports = router;