import { asyncHandler } from '../utils/asyncHandler.js';
import { Errors } from '../utils/errors.js';

const CLIENT_FORBIDDEN_KEYS = ['restaurantId', 'databaseName', 'clusterId'];

/**
 * Removes tenant-selection fields from body and query on every request,
 * so no handler can accidentally read a client-chosen tenant.
 * (Super Admin routes identify restaurants via URL params, which are not touched.)
 */
export function stripTenantOverrides(req, _res, next) {
  for (const source of [req.body, req.query]) {
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const key of CLIENT_FORBIDDEN_KEYS) delete source[key];
    }
  }
  next();
}

/**
 * Authenticated restaurant routes. Expects an earlier auth middleware (Phase 4)
 * to have verified the token and set req.auth = { sub, restaurantId, role, aud, ... }.
 */
export function tenantFromAuth(tenantManager) {
  return asyncHandler(async (req, _res, next) => {
    const auth = req.auth;
    if (!auth || auth.aud !== 'restaurant' || !auth.restaurantId) {
      throw Errors.unauthorized();
    }
    req.tenant = await tenantManager.resolveById(auth.restaurantId);
    next();
  });
}

/** Public menu routes: the tenant comes from the URL slug. */
export function tenantFromSlug(tenantManager, param = 'slug') {
  return asyncHandler(async (req, _res, next) => {
    req.tenant = await tenantManager.resolveBySlug(req.params[param]);
    next();
  });
}
