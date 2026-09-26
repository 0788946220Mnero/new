import { dummyVerify, hashPassword, passwordSchema, verifyPassword } from '../auth/password.js';
import { parseSetupToken } from '../auth/setupLinks.js';
import { RESTAURANT_ACCESS_TTL_SECONDS } from '../auth/tokens.js';
import { effectivePermissions } from '../roles/permissions.js';
import { AppError } from '../utils/errors.js';
import { SessionService } from './sessions.service.js';
import { tenantAudit } from './tenantAudit.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

const invalidCredentials = () => new AppError(401, 'Invalid email or password', { code: 'INVALID_CREDENTIALS' });
const invalidSetupToken = () => new AppError(400, 'This link is invalid or has expired', { code: 'INVALID_SETUP_TOKEN' });
const sessionExpired = () => new AppError(401, 'Session expired. Please sign in again', { code: 'SESSION_EXPIRED' });
const locked = () => new AppError(429, 'Too many failed attempts. Try again later', { code: 'ACCOUNT_LOCKED' });
const weakPassword = (msg) => new AppError(400, msg, { code: 'WEAK_PASSWORD' });

export function publicUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: effectivePermissions(user),
  };
}

/**
 * Sign-in for restaurant owners and employees.
 * email -> userDirectory -> restaurant -> its own database -> user -> password.
 * Access token (10 min, response body) + refresh session (httpOnly cookie).
 */
export class RestaurantAuthService {
  #models;
  #tenantManager;
  #sessions;
  #tokens;
  #logger;
  #now;

  constructor({ registryModels, tenantManager, sessions, tokens, logger, now = () => Date.now() }) {
    this.#models = registryModels;
    this.#tenantManager = tenantManager;
    this.#sessions = sessions;
    this.#tokens = tokens;
    this.#logger = logger;
    this.#now = now;
  }

  async setupPassword({ token, password, ip, userAgent }) {
    const parsed = parseSetupToken(token);
    if (!parsed) throw invalidSetupToken();
    const pw = passwordSchema.safeParse(password);
    if (!pw.success) throw weakPassword(pw.error.issues[0].message);

    const tenant = await this.#tenantManager.resolveById(parsed.restaurantId).catch((err) => {
      if (err.code === 'TENANT_UNAVAILABLE') throw err;
      throw invalidSetupToken();
    });
    const { User } = tenant.models;
    const now = new Date(this.#now());

    const user = await User.findOne({ setupTokenHash: parsed.hash, setupTokenExpiresAt: { $gt: now } }).lean();
    if (!user || user.status === 'disabled') throw invalidSetupToken();

    // Conditional on the token hash: a link can be used exactly once, even under races.
    const res = await User.updateOne(
      { _id: user._id, setupTokenHash: parsed.hash },
      {
        $set: { passwordHash: await hashPassword(password), status: 'active', passwordChangedAt: now, failedLoginCount: 0 },
        $unset: { setupTokenHash: 1, setupTokenExpiresAt: 1, lockUntil: 1 },
        $inc: { tokenVersion: 1 },
      },
    );
    if (res.modifiedCount !== 1) throw invalidSetupToken();
    const updated = await User.findById(user._id).lean();

    await this.#sessions.revokeAllForUser(tenant.restaurantId, user._id);
    await tenantAudit(tenant, { userId: String(user._id), action: 'user.password_set', resource: 'user', resourceId: String(user._id), ip }, this.#logger);
    return this.#startSession(tenant, updated, { ip, userAgent });
  }

  async login({ email, password, ip, userAgent }) {
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const entry = normalized ? await this.#models.UserDirectory.findOne({ email: normalized }).lean() : null;
    if (!entry) {
      await dummyVerify(password);
      throw invalidCredentials();
    }

    // Suspended/archived restaurants get a clear message; missing/failed ones look like bad credentials.
    const tenant = await this.#tenantManager.resolveById(entry.restaurantId).catch((err) => {
      if (err.code === 'TENANT_UNAVAILABLE') throw err;
      return null;
    });
    if (!tenant) {
      await dummyVerify(password);
      throw invalidCredentials();
    }

    const { User } = tenant.models;
    const user = await User.findById(entry.userId).select('+passwordHash').lean();
    if (!user || !user.passwordHash || user.status !== 'active') {
      await dummyVerify(password);
      throw invalidCredentials();
    }
    if (user.lockUntil && user.lockUntil.getTime() > this.#now()) throw locked();

    if (!(await verifyPassword(user.passwordHash, password))) {
      await User.updateOne({ _id: user._id }, { $inc: { failedLoginCount: 1 } });
      await User.updateOne(
        { _id: user._id, failedLoginCount: { $gte: MAX_FAILED_ATTEMPTS } },
        { $set: { lockUntil: new Date(this.#now() + LOCK_MS), failedLoginCount: 0 } },
      );
      await tenantAudit(tenant, { userId: String(user._id), action: 'user.login_failed', resource: 'user', resourceId: String(user._id), ip }, this.#logger);
      throw invalidCredentials();
    }

    await User.updateOne(
      { _id: user._id },
      { $set: { failedLoginCount: 0, lastLoginAt: new Date(this.#now()) }, $unset: { lockUntil: 1 } },
    );
    await tenantAudit(tenant, { userId: String(user._id), action: 'user.login', resource: 'user', resourceId: String(user._id), ip }, this.#logger);
    return this.#startSession(tenant, user, { ip, userAgent });
  }

  async refresh({ cookieValue }) {
    const result = await this.#sessions.rotate(cookieValue);
    if (result.status === 'invalid') throw sessionExpired();

    const s = result.session;
    if (result.status === 'reuse') {
      this.#logger?.warn({ restaurantId: s.restaurantId, userId: s.userId }, 'Refresh token reuse detected; session revoked');
      const tenant = await this.#tenantManager.resolveById(s.restaurantId).catch(() => null);
      if (tenant) {
        await tenantAudit(tenant, { userId: s.userId, action: 'session.reuse_detected', resource: 'user', resourceId: s.userId }, this.#logger);
      }
      throw sessionExpired();
    }

    let tenant;
    try {
      tenant = await this.#tenantManager.resolveById(s.restaurantId);
    } catch (err) {
      await this.#sessions.revoke(s.sessionId);
      throw err.code === 'TENANT_UNAVAILABLE' ? err : sessionExpired();
    }
    const user = await tenant.models.User.findById(s.userId).lean();
    if (!user || user.status !== 'active') {
      await this.#sessions.revoke(s.sessionId);
      throw sessionExpired();
    }

    return {
      ...this.#payload(tenant, user, s.sessionId),
      cookie: result.status === 'rotated' ? { value: result.cookieValue, expiresAt: result.expiresAt } : null,
    };
  }

  async logout({ cookieValue }) {
    const parsed = SessionService.parse(cookieValue);
    if (parsed) await this.#sessions.revoke(parsed.sessionId);
  }

  /** Changes the password and signs out every other device. */
  async changePassword({ tenant, userId, currentPassword, newPassword, ip, userAgent }) {
    const pw = passwordSchema.safeParse(newPassword);
    if (!pw.success) throw weakPassword(pw.error.issues[0].message);
    const { User } = tenant.models;
    const user = await User.findById(userId).select('+passwordHash').lean();
    if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new AppError(401, 'Current password is incorrect', { code: 'INVALID_CREDENTIALS' });
    }
    if (currentPassword === newPassword) {
      throw new AppError(400, 'New password must be different', { code: 'PASSWORD_REUSED' });
    }
    await User.updateOne(
      { _id: user._id },
      {
        $set: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date(this.#now()) },
        $inc: { tokenVersion: 1 },
      },
    );
    await this.#sessions.revokeAllForUser(tenant.restaurantId, user._id);
    await tenantAudit(tenant, { userId: String(user._id), action: 'user.password_changed', resource: 'user', resourceId: String(user._id), ip }, this.#logger);
    return this.#startSession(tenant, await User.findById(user._id).lean(), { ip, userAgent });
  }

  me(tenant, user) {
    return { user, restaurant: { restaurantId: tenant.restaurantId, name: tenant.name, slug: tenant.slug } };
  }

  async #startSession(tenant, user, { ip, userAgent }) {
    const session = await this.#sessions.create({ restaurantId: tenant.restaurantId, userId: user._id, ip, userAgent });
    return {
      ...this.#payload(tenant, user, session.sessionId),
      cookie: { value: session.cookieValue, expiresAt: session.expiresAt },
    };
  }

  #payload(tenant, user, sessionId) {
    return {
      accessToken: this.#tokens.signAccess({
        userId: user._id,
        restaurantId: tenant.restaurantId,
        role: user.role,
        sessionId,
        tokenVersion: user.tokenVersion ?? 0,
      }),
      expiresIn: RESTAURANT_ACCESS_TTL_SECONDS,
      user: publicUser(user),
      restaurant: { restaurantId: tenant.restaurantId, name: tenant.name, slug: tenant.slug },
    };
  }
}
