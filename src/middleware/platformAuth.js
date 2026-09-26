import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/errors.js';

/**
 * Protects /api/platform/* routes. Tokens come only from the Authorization header
 * (never cookies), so Super Admin routes are not exposed to CSRF.
 * Until the initial password is changed, only the auth routes that pass
 * { allowPasswordChangePending: true } are reachable.
 */
export function requirePlatformAuth(authService, { allowPasswordChangePending = false } = {}) {
  return asyncHandler(async (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new AppError(401, 'Unauthorized', { code: 'UNAUTHORIZED' });
    }
    const user = await authService.authenticate(token);
    if (user.mustChangePassword && !allowPasswordChangePending) {
      throw new AppError(403, 'You must change your password first', { code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    req.platformUser = user;
    next();
  });
}
