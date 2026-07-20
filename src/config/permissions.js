// Defines which modules each staff role can access in the Admin Panel.
const ROLE_PERMISSIONS = {
  admin:    ["*"], // full access — bypasses module checks entirely
  manager:  ["orders", "clients", "billing", "reports", "export"],
  employee: ["orders", "clients", "inventory", "search"],
};

function hasPermission(role, moduleName) {
  const allowed = ROLE_PERMISSIONS[role];
  if (!allowed) return false;
  return allowed.includes("*") || allowed.includes(moduleName);
}

module.exports = { ROLE_PERMISSIONS, hasPermission };
