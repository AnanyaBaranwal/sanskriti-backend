const AuditLog = require("../models/AuditLog.model");

/**
 * Log any admin/staff/seller action to the audit trail.
 *
 * Works for both auth systems:
 *  - Staff (admin panel) routes set req.staff via protectStaff middleware
 *  - Seller (seller dashboard) routes set req.seller via protect middleware
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
    // Prefer req.staff (admin panel) if present, fall back to req.seller
    // (seller dashboard). At most one of these will be set on any given
    // request, depending on which auth middleware ran.
    const actor = req.staff || req.seller || {};
    const actorModel = req.staff ? "Staff" : "Seller";

    await AuditLog.create({
      performedBy:      actor.id,
      performedByModel: actorModel,
      performedByName:  actor.name || null,
      performedByRole:  actor.role || null,
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
