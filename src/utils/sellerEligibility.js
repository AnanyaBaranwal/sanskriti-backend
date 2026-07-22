const Seller = require("../models/Seller.model");
const Kyc = require("../models/Kyc.model");

// Checked before a seller may recharge their wallet (paymentController.js
// createOrder — the Razorpay order creation step, before checkout even
// opens) or place an order (orderController.js createOrder). Kept in one
// place so both enforce the exact same rule and can never drift apart.
async function checkSellerEligibility(sellerId) {
  const [seller, kyc] = await Promise.all([
    Seller.findById(sellerId).select("company gstNumber address bankDetails"),
    Kyc.findOne({ sellerId }).select("status"),
  ]);

  const missing = [];

  if (!seller?.company?.trim())                     missing.push("Business Name");
  if (!seller?.gstNumber?.trim())                    missing.push("GST Number");
  if (!seller?.address?.street?.trim())              missing.push("Street Address");
  if (!seller?.address?.city?.trim())                missing.push("City");
  if (!seller?.address?.state?.trim())               missing.push("State");
  if (!seller?.address?.pincode?.trim())              missing.push("Pincode");
  if (!seller?.bankDetails?.accountHolder?.trim())   missing.push("Bank Account Holder Name");
  if (!seller?.bankDetails?.bankName?.trim())        missing.push("Bank Name");
  if (!seller?.bankDetails?.accountNumber?.trim())   missing.push("Bank Account Number");
  if (!seller?.bankDetails?.ifsc?.trim())            missing.push("Bank IFSC Code");

  const kycStatus = kyc?.status || "not_submitted";
  const kycApproved = kycStatus === "approved";

  return {
    eligible: missing.length === 0 && kycApproved,
    missingProfileFields: missing,
    kycApproved,
    kycStatus,
  };
}

// Builds a single human-readable message covering both profile gaps and
// KYC status, so the frontend can show one clear error instead of two.
function eligibilityMessage({ missingProfileFields, kycApproved, kycStatus }) {
  const parts = [];
  if (missingProfileFields.length > 0) {
    parts.push(`Please complete your profile: ${missingProfileFields.join(", ")}.`);
  }
  if (!kycApproved) {
    const kycNote = {
      not_submitted: "Please submit your KYC documents for verification.",
      under_review:  "Your KYC is still under review.",
      rejected:       "Your KYC was rejected — please re-submit your documents.",
    }[kycStatus] || "KYC verification is required.";
    parts.push(kycNote);
  }
  return parts.join(" ");
}

module.exports = { checkSellerEligibility, eligibilityMessage };
