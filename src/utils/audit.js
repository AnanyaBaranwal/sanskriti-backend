const AuditLog = require("../models/AuditLog.model");

/**
 * Log any admin/seller action to the audit trail.
 *
 * Usage examples:
 *
 *   // In a route handler, after updating an order:
 *   await logAction(req, {
 *     action: "STATUS_CHANGE",
 *     entity: "Order",
 *     entityId: order._id,
 *     entityRef: order.orderNumber,
 *     description: `Order status changed from PENDING to CONFIRMED`,
 *     before: { status: "PENDING" },
 *     after:  { status: "CONFIRMED" },
 *   });
 *
 *   // Minimal usage (no before/after needed):
 *   await logAction(req, {
 *     action: "EXPORT",
 *     entity: "Order",
 *     description: "Exported orders to Excel",
 *   });
 */
const logAction = async (req, { action, entity, entityId = null, entityRef = null, description, before = null, after = null }) => {
  try {
    // req.seller is set by the protect middleware
    const seller = req.seller || {};

    await AuditLog.create({
      performedBy:     seller.id,
      performedByName: seller.name  || null,
      performedByRole: seller.role  || null,
      action,
      entity,
      entityId:    entityId  || null,
      entityRef:   entityRef || null,
      description,
      before,
      after,
      ip:        req.ip || req.connection?.remoteAddress || null,
      userAgent: req.headers?.["user-agent"] || null,
    });
  } catch (err) {
    // Never let audit logging break the actual request
    console.error("[AuditLog] Failed to log action:", err.message);
  }
};

module.exports = { logAction };
