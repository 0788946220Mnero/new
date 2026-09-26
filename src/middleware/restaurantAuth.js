import { effectivePermissions } from '../roles/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError, Errors } from '../utils/errors.js';

const unauthorized = () => new AppError(401, 'Unauthorized', { code: 'UNAUTHORIZED' });

/**
 * Authentication -> tenant resolution -> current user, in that order, on every request.
 * The restaurant comes ONLY from the verified token. The user is re-read from the
 * restaurant's database, and its tokenVersion must match the token's, so disabled users
 * and changed passwords are rejected immediately (no dependence on server clocks).
 */
export function requireRestaurantAuth({ tokens, tenantManager }) {
  return asyncHandler(async (req, _res, next) => {
    const [scheme, token] = (req.get('authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw unauthorized();

    const payload = tokens.verify(token);
    if (!payload?.restaurantId || !payload.sub) throw unauthorized();

    req.auth = { sub: payload.sub, restaurantId: payload.restaurantId, role: payload.role, sid: payload.sid, aud: 'restaurant' };
    req.tenant = await tenantManager.resolveById(payload.restaurantId);

    const user = await req.tenant.models.User.findById(payload.sub).lean().catch(() => null);
    if (!user || user.status !== 'active' || (user.tokenVersion ?? 0) !== payload.ver) throw unauthorized();

    req.user = {
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      permissions: effectivePermissions(user),
    };
    next();
  });
}

/** Must follow requireRestaurantAuth. All listed permissions are required. */
export function requirePermission(...permissions) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    const allowed = permissions.every((p) => req.user.permissions.includes(p));
    if (!allowed) return next(Errors.forbidden('You do not have permission to do this', { code: 'FORBIDDEN' }));
    next();
  };
}
