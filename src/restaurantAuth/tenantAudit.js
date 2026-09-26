/** Writes to the restaurant's own auditLogs collection. Never throws. */
export async function tenantAudit(tenant, { userId, action, resource, resourceId, ip, metadata }, logger) {
  try {
    await tenant.models.AuditLog.create({ userId, action, resource, resourceId, ip, metadata });
  } catch (err) {
    logger?.error({ err, action, restaurantId: tenant.restaurantId }, 'Failed to write tenant audit log');
  }
}
