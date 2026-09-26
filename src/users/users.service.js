import mongoose from 'mongoose';
import { issueSetupLink } from '../auth/setupLinks.js';
import { tenantAudit } from '../restaurantAuth/tenantAudit.js';
import { effectivePermissions, ROLE_PERMISSIONS } from '../roles/permissions.js';
import { AppError, Errors } from '../utils/errors.js';

const notFound = () => Errors.notFound('User not found', { code: 'USER_NOT_FOUND' });

function toView(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    permissions: effectivePermissions(user),
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

/**
 * Restaurant employees, managed by the Owner (users.manage).
 * Only Editors are managed here: the Owner account is never changed through these routes
 * (the Super Admin resets owner access), and Editors can never receive users.manage.
 */
export class UsersService {
  #models;
  #sessions;
  #dashboardUrl;
  #logger;
  #maxUsers;
  #now;

  constructor({ registryModels, sessions, dashboardUrl, logger, maxUsers = 25, now = () => Date.now() }) {
    this.#models = registryModels;
    this.#sessions = sessions;
    this.#dashboardUrl = dashboardUrl;
    this.#logger = logger;
    this.#maxUsers = maxUsers;
    this.#now = now;
  }

  async list(tenant) {
    const users = await tenant.models.User.find({}).sort({ createdAt: 1 }).lean();
    return users.map(toView);
  }

  async invite(tenant, input, { actor, ip }) {
    const { User } = tenant.models;
    if ((await User.countDocuments()) >= this.#maxUsers) {
      throw Errors.conflict(`A restaurant can have at most ${this.#maxUsers} users`, { code: 'USER_LIMIT' });
    }
    const email = input.email.toLowerCase();
    if (await this.#models.UserDirectory.exists({ email })) {
      throw Errors.conflict('This email is already used', { code: 'EMAIL_IN_USE' });
    }

    let user;
    try {
      user = await User.create({
        email,
        name: input.name,
        phone: input.phone,
        role: 'Editor',
        permissions: input.permissions ?? [...ROLE_PERMISSIONS.Editor],
        status: 'invited',
      });
    } catch (err) {
      if (err?.code === 11000) throw Errors.conflict('This email is already used', { code: 'EMAIL_IN_USE' });
      throw err;
    }

    try {
      await this.#models.UserDirectory.create({ email, restaurantId: tenant.restaurantId, userId: String(user._id) });
    } catch (err) {
      await User.deleteOne({ _id: user._id });
      if (err?.code === 11000) throw Errors.conflict('This email is already used', { code: 'EMAIL_IN_USE' });
      throw err;
    }

    const setup = await issueSetupLink({
      User,
      userId: user._id,
      restaurantId: tenant.restaurantId,
      dashboardUrl: this.#dashboardUrl,
      now: this.#now(),
    });
    await tenantAudit(tenant, { userId: actor.id, action: 'user.invited', resource: 'user', resourceId: String(user._id), ip, metadata: { email } }, this.#logger);
    return { user: toView(user.toObject()), setup };
  }

  async update(tenant, userId, patch, { actor, ip }) {
    const user = await this.#editor(tenant, userId, '+passwordHash');
    const $set = {};
    const $unset = {};
    let $inc;
    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.phone !== undefined) $set.phone = patch.phone;
    if (patch.permissions !== undefined) $set.permissions = patch.permissions;

    let revoke = false;
    if (patch.status === 'disabled' && user.status !== 'disabled') {
      $set.status = 'disabled';
      $inc = { tokenVersion: 1 };
      $unset.setupTokenHash = 1;
      $unset.setupTokenExpiresAt = 1;
      revoke = true;
    } else if (patch.status === 'active' && user.status === 'disabled') {
      // Re-enabled users without a password go back to "invited" and need a new link.
      $set.status = user.passwordHash ? 'active' : 'invited';
    }
    // Permission changes need no revocation: permissions are re-read from the database on every request.

    if (Object.keys($set).length || Object.keys($unset).length) {
      await tenant.models.User.updateOne({ _id: user._id }, { $set, $unset, ...($inc ? { $inc } : {}) });
    }
    if (revoke && $set.status === 'disabled') {
      await this.#sessions.revokeAllForUser(tenant.restaurantId, user._id);
    }

    await tenantAudit(tenant, {
      userId: actor.id,
      action: $set.status === 'disabled' ? 'user.disabled' : 'user.updated',
      resource: 'user',
      resourceId: String(user._id),
      ip,
      metadata: { fields: [...Object.keys($set), ...Object.keys($unset)] },
    }, this.#logger);

    return toView(await tenant.models.User.findById(user._id).lean());
  }

  /** New one-time link; the old password and any old link stop working immediately. */
  async resetAccess(tenant, userId, { actor, ip }) {
    const user = await this.#editor(tenant, userId);
    if (user.status === 'disabled') {
      throw Errors.conflict('Enable the user before resetting access', { code: 'USER_DISABLED' });
    }
    await tenant.models.User.updateOne(
      { _id: user._id },
      { $set: { status: 'invited', failedLoginCount: 0 }, $unset: { passwordHash: 1, lockUntil: 1 }, $inc: { tokenVersion: 1 } },
    );
    await this.#sessions.revokeAllForUser(tenant.restaurantId, user._id);
    const setup = await issueSetupLink({
      User: tenant.models.User,
      userId: user._id,
      restaurantId: tenant.restaurantId,
      dashboardUrl: this.#dashboardUrl,
      now: this.#now(),
    });
    await tenantAudit(tenant, { userId: actor.id, action: 'user.access_reset', resource: 'user', resourceId: String(user._id), ip }, this.#logger);
    return { user: toView({ ...user, status: 'invited' }), setup };
  }

  async remove(tenant, userId, { actor, ip }) {
    const user = await this.#editor(tenant, userId);
    await this.#sessions.revokeAllForUser(tenant.restaurantId, user._id);
    await this.#models.UserDirectory.deleteOne({ email: user.email, restaurantId: tenant.restaurantId });
    await tenant.models.User.deleteOne({ _id: user._id });
    await tenantAudit(tenant, { userId: actor.id, action: 'user.deleted', resource: 'user', resourceId: String(user._id), ip, metadata: { email: user.email } }, this.#logger);
    return { id: String(user._id), deleted: true };
  }

  async #editor(tenant, userId, select) {
    if (!mongoose.isValidObjectId(userId)) throw notFound();
    const query = tenant.models.User.findById(userId);
    if (select) query.select(select);
    const user = await query.lean();
    if (!user) throw notFound();
    if (user.role === 'Owner') {
      throw new AppError(403, 'The owner account cannot be changed here', { code: 'OWNER_PROTECTED' });
    }
    return user;
  }
}
