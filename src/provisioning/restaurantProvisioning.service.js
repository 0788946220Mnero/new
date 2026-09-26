import { issueSetupLink } from '../auth/setupLinks.js';
import { createTenantCollections, getTenantModels } from '../tenants/tenant.models.js';
import {
  databaseNameFor,
  generateRestaurantId,
  isValidRestaurantId,
  normalizeSlug,
} from '../tenants/tenantNaming.js';
import { AppError, Errors } from '../utils/errors.js';

export const PROVISIONING_STEPS = Object.freeze(['collections', 'owner', 'settings', 'media', 'audit']);

const STALE_PROVISIONING_MS = 10 * 60 * 1000;

const slugTaken = () => Errors.conflict('This slug is already in use', { code: 'SLUG_TAKEN' });
const emailInUse = () =>
  Errors.conflict('This owner email is already used by another restaurant', { code: 'EMAIL_IN_USE' });

function slugFromName(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/**
 * Creates a restaurant end to end, with no manual Atlas work:
 * registry record -> dedicated database -> collections/indexes -> owner ->
 * directory entry -> settings -> media folder -> audit -> active.
 *
 * MongoDB transactions can't cover collection/index creation, so this is a state
 * machine instead: each step is idempotent and recorded in provisioningSteps.
 * A failure leaves status "failed" with the error; retry() resumes, cleanup() removes.
 */
export class RestaurantProvisioningService {
  #models;
  #clusters;
  #tenantManager;
  #audit;
  #logger;
  #dashboardUrl;
  #hooks;
  #now;
  #sessions;

  constructor({ registryModels, clusters, tenantManager, audit, logger, dashboardUrl, sessions, hooks = {}, now = () => Date.now() }) {
    this.#sessions = sessions;
    this.#models = registryModels;
    this.#clusters = clusters;
    this.#tenantManager = tenantManager;
    this.#audit = audit;
    this.#logger = logger;
    this.#dashboardUrl = dashboardUrl?.replace(/\/+$/, '');
    this.#hooks = hooks;
    this.#now = now;
  }

  /** input is already validated by the route schema. */
  /** trialDays: set for self-registration — the restaurant works for that many days until approved. */
  async create(input, { actor, ip, trialDays } = {}) {
    const { Restaurant, UserDirectory } = this.#models;
    const ownerEmail = input.owner.email.toLowerCase();

    if (await UserDirectory.exists({ email: ownerEmail })) throw emailInUse();

    let explicitSlug = null;
    if (input.slug) {
      explicitSlug = normalizeSlug(input.slug);
      if (!explicitSlug) throw Errors.badRequest('Invalid or reserved slug', { code: 'INVALID_SLUG' });
      if (await Restaurant.exists({ slug: explicitSlug })) throw slugTaken();
    }

    const record = await this.#insertRegistryRecord(input, ownerEmail, explicitSlug, actor, trialDays);
    await this.#audit.log({
      actor,
      ip,
      action: trialDays ? 'restaurant.self_registered' : 'restaurant.created',
      resource: 'restaurant',
      resourceId: record.restaurantId,
      restaurantId: record.restaurantId,
      metadata: { name: record.name, slug: record.slug },
    });

    return this.#provision(record, { actor, ip });
  }

  /** Resume a failed (or stuck) provisioning. Completed steps are skipped. */
  async retry(restaurantId, { actor, ip } = {}) {
    const record = await this.#getRecord(restaurantId);
    if (!this.#isRecoverable(record)) {
      throw Errors.conflict('Only failed provisioning can be retried', { code: 'INVALID_STATE' });
    }
    const claimed = await this.#models.Restaurant.findOneAndUpdate(
      { restaurantId, status: record.status, updatedAt: record.updatedAt },
      { $set: { status: 'provisioning', statusChangedAt: new Date(this.#now()) }, $unset: { provisioningError: 1 } },
      { new: true },
    ).lean();
    if (!claimed) throw Errors.conflict('Provisioning is already running', { code: 'INVALID_STATE' });

    await this.#audit.log({ actor, ip, action: 'restaurant.provisioning_retried', resource: 'restaurant', resourceId: restaurantId, restaurantId });
    return this.#provision(claimed, { actor, ip });
  }

  /** Removes a restaurant whose provisioning failed: directory entries, database, registry record. */
  async cleanup(restaurantId, { actor, ip } = {}) {
    const record = await this.#getRecord(restaurantId);
    if (!this.#isRecoverable(record)) {
      throw Errors.conflict('Only restaurants whose provisioning failed can be deleted', { code: 'INVALID_STATE' });
    }
    const { Restaurant, UserDirectory } = this.#models;

    // Order matters: the registry record goes last so a failed cleanup can simply be re-run.
    await UserDirectory.deleteMany({ restaurantId });
    const db = await this.#rawTenantDb(record);
    await db.dropDatabase();
    await Restaurant.deleteOne({ restaurantId, status: record.status });
    this.#tenantManager.invalidate(restaurantId);

    await this.#audit.log({
      actor,
      ip,
      action: 'restaurant.provisioning_cleaned_up',
      resource: 'restaurant',
      resourceId: restaurantId,
      restaurantId,
      metadata: { slug: record.slug, databaseName: record.databaseName },
    });
    return { restaurantId, deleted: true };
  }

  /** New one-time setup link for the owner. The old password and old links stop working. */
  async resetOwnerAccess(restaurantId, { actor, ip } = {}) {
    const record = await this.#getRecord(restaurantId);
    if (!['active', 'suspended'].includes(record.status) || !record.ownerUserId) {
      throw Errors.conflict('Owner access can only be reset for active or suspended restaurants', { code: 'INVALID_STATE' });
    }
    const db = await this.#rawTenantDb(record);
    const { User } = getTenantModels(db);
    const reset = await User.updateOne(
      { _id: record.ownerUserId, role: 'Owner' },
      { $set: { status: 'invited', failedLoginCount: 0 }, $unset: { passwordHash: 1, lockUntil: 1 }, $inc: { tokenVersion: 1 } },
    );
    const owner = reset.matchedCount ? await User.findById(record.ownerUserId).lean() : null;
    if (!owner) throw Errors.notFound('Owner not found', { code: 'OWNER_NOT_FOUND' });
    await this.#sessions?.revokeAllForUser(restaurantId, owner._id);

    const setup = await this.#issueSetupLink(record, db);
    await this.#audit.log({ actor, ip, action: 'restaurant.owner_access_reset', resource: 'restaurant', resourceId: restaurantId, restaurantId });
    return { restaurantId, ownerEmail: owner.email, ...setup };
  }

  // ---------------------------------------------------------------------------

  async #insertRegistryRecord(input, ownerEmail, explicitSlug, actor, trialDays) {
    const { Restaurant, PlatformSetting } = this.#models;
    const defaults = (await PlatformSetting.findOne({ key: 'defaultLimits' }).lean())?.value ?? {};

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const restaurantId = generateRestaurantId();
      const suffix = restaurantId.slice(5).toLowerCase();
      let slug = explicitSlug;
      if (!slug) {
        const base = normalizeSlug(slugFromName(input.name)) ?? `menu-${suffix}`;
        slug = (await Restaurant.exists({ slug: base })) ? `${base.slice(0, 40)}-${suffix.slice(0, 4)}` : base;
      }

      try {
        const doc = await Restaurant.create({
          restaurantId,
          databaseName: databaseNameFor(restaurantId), // server-side only, derived from the id
          clusterId: 'primary',
          name: input.name,
          slug,
          status: 'provisioning',
          statusChangedAt: new Date(this.#now()),
          contact: { phone: input.phone, email: input.email, address: input.address },
          owner: { name: input.owner.name, email: ownerEmail, phone: input.owner.phone },
          limits: { ...defaults, ...input.limits },
          notes: input.notes,
          ...(trialDays
            ? { approved: false, signupSource: 'self', trialEndsAt: new Date(this.#now() + trialDays * 24 * 60 * 60 * 1000) }
            : { approved: true, signupSource: 'admin' }),
        });
        this.#tenantManager.invalidateSlug(slug);
        this.#logger?.info({ restaurantId, slug, by: actor?.email }, 'Restaurant registered');
        return doc.toObject();
      } catch (err) {
        if (err?.code !== 11000) throw err;
        if (err.keyPattern?.slug) {
          if (explicitSlug) throw slugTaken();
          continue; // auto slug raced; try again
        }
        // restaurantId / databaseName collision: generate another id
      }
    }
    throw Errors.internal('Could not allocate a unique restaurant id');
  }

  async #provision(record, { actor, ip }) {
    const { restaurantId } = record;
    const done = new Set(Object.keys(record.provisioningSteps ?? {}));
    let current;

    try {
      const db = await this.#rawTenantDb(record);
      const models = getTenantModels(db);

      for (const step of PROVISIONING_STEPS) {
        if (done.has(step)) continue;
        current = step;
        await this.#hooks.beforeStep?.(step, record);
        await this.#runStep(step, record, db, models, actor);
        await this.#models.Restaurant.updateOne(
          { restaurantId },
          { $set: { [`provisioningSteps.${step}`]: new Date(this.#now()) } },
        );
      }

      await this.#models.Restaurant.updateOne(
        { restaurantId, status: 'provisioning' },
        { $set: { status: 'active', statusChangedAt: new Date(this.#now()) }, $unset: { provisioningError: 1 } },
      );
      this.#tenantManager.invalidate(restaurantId);
      this.#tenantManager.invalidateSlug(record.slug);

      const setup = await this.#issueSetupLink(record, db);
      await this.#audit.log({ actor, ip, action: 'restaurant.provisioned', resource: 'restaurant', resourceId: restaurantId, restaurantId });
      this.#logger?.info({ restaurantId }, 'Restaurant provisioned');

      const fresh = await this.#models.Restaurant.findOne({ restaurantId }).lean();
      return { restaurant: toPublicRecord(fresh), owner: { email: record.owner.email, ...setup } };
    } catch (err) {
      const clientError = err instanceof AppError && err.statusCode < 500;
      const safeMessage = clientError ? err.message : `Step "${current ?? 'init'}" failed`;
      this.#logger?.error({ err, restaurantId, step: current }, 'Restaurant provisioning failed');

      await this.#models.Restaurant.updateOne(
        { restaurantId },
        { $set: { status: 'failed', statusChangedAt: new Date(this.#now()), provisioningError: safeMessage } },
      ).catch(() => undefined);
      this.#tenantManager.invalidate(restaurantId);
      await this.#audit.log({
        actor,
        ip,
        action: 'restaurant.provisioning_failed',
        resource: 'restaurant',
        resourceId: restaurantId,
        restaurantId,
        metadata: { step: current, error: safeMessage },
      });

      throw new AppError(clientError ? err.statusCode : 500, clientError ? err.message : 'Restaurant provisioning failed', {
        code: clientError ? err.code : 'PROVISIONING_FAILED',
        details: { restaurantId, step: current, status: 'failed' },
        cause: err,
      });
    }
  }

  async #runStep(step, record, db, models, actor) {
    const { restaurantId } = record;

    switch (step) {
      case 'collections':
        await createTenantCollections(db);
        return;

      case 'owner': {
        const email = record.owner.email;
        await models.User.updateOne(
          { email },
          {
            $setOnInsert: {
              email,
              name: record.owner.name,
              phone: record.owner.phone,
              role: 'Owner',
              permissions: [],
              status: 'invited',
            },
          },
          { upsert: true, runValidators: true },
        );
        const owner = await models.User.findOne({ email }).lean();
        const userId = String(owner._id);

        try {
          await this.#models.UserDirectory.updateOne(
            { email },
            { $setOnInsert: { email, restaurantId, userId } },
            { upsert: true },
          );
        } catch (err) {
          if (err?.code !== 11000) throw err; // concurrent insert; checked below
        }
        const entry = await this.#models.UserDirectory.findOne({ email }).lean();
        if (!entry || entry.restaurantId !== restaurantId) throw emailInUse();

        await this.#models.Restaurant.updateOne({ restaurantId }, { $set: { ownerUserId: userId } });
        record.ownerUserId = userId;
        return;
      }

      case 'settings':
        await models.Settings.updateOne(
          { _id: 'main' },
          {
            $setOnInsert: {
              info: {
                name: record.name,
                phone: record.contact?.phone,
                address: record.contact?.address,
              },
            },
          },
          { upsert: true, setDefaultsOnInsert: true, runValidators: true },
        );
        return;

      case 'media':
        // Cloudinary creates folders on first upload; we pin the folder here so
        // uploads (Phase 8) always go under restaurants/{restaurantId}/.
        await this.#models.Restaurant.updateOne(
          { restaurantId },
          { $set: { mediaFolder: `restaurants/${restaurantId}` } },
        );
        return;

      case 'audit':
        await models.AuditLog.updateOne(
          { action: 'restaurant.provisioned' },
          {
            $setOnInsert: {
              action: 'restaurant.provisioned',
              resource: 'restaurant',
              resourceId: restaurantId,
              userId: actor?.id,
              metadata: { by: 'platform', actorEmail: actor?.email },
            },
          },
          { upsert: true },
        );
        return;

      default:
        throw new Error(`Unknown provisioning step ${step}`);
    }
  }

  async #issueSetupLink(record, db) {
    const { User } = getTenantModels(db);
    const ownerId =
      record.ownerUserId ?? (await User.findOne({ role: 'Owner', email: record.owner.email }).lean())?._id;
    return issueSetupLink({
      User,
      userId: ownerId,
      restaurantId: record.restaurantId,
      dashboardUrl: this.#dashboardUrl,
      now: this.#now(),
    });
  }

  async #rawTenantDb(record) {
    const expected = databaseNameFor(record.restaurantId);
    if (record.databaseName !== expected) {
      this.#logger?.error({ restaurantId: record.restaurantId }, 'Registry routing integrity violation');
      throw Errors.internal();
    }
    const conn = await this.#clusters.connect(record.clusterId ?? 'primary');
    return conn.useDb(expected, { useCache: true });
  }

  async #getRecord(restaurantId) {
    if (!isValidRestaurantId(restaurantId)) throw Errors.notFound('Restaurant not found', { code: 'TENANT_NOT_FOUND' });
    const record = await this.#models.Restaurant.findOne({ restaurantId }).lean();
    if (!record) throw Errors.notFound('Restaurant not found', { code: 'TENANT_NOT_FOUND' });
    return record;
  }

  #isRecoverable(record) {
    if (record.status === 'failed') return true;
    return (
      record.status === 'provisioning' &&
      this.#now() - new Date(record.updatedAt).getTime() > STALE_PROVISIONING_MS
    );
  }
}

/** Registry record as shown to Super Admins (includes the database mapping). */
export function toPublicRecord(r) {
  if (!r) return r;
  return {
    restaurantId: r.restaurantId,
    name: r.name,
    slug: r.slug,
    status: r.status,
    databaseName: r.databaseName,
    clusterId: r.clusterId,
    mediaFolder: r.mediaFolder,
    owner: r.owner,
    ownerUserId: r.ownerUserId,
    approved: r.approved !== false,
    trialEndsAt: r.approved === false ? r.trialEndsAt ?? null : null,
    approvedAt: r.approvedAt,
    signupSource: r.signupSource ?? 'admin',
    contact: r.contact,
    limits: r.limits,
    notes: r.notes,
    provisioningSteps: r.provisioningSteps,
    provisioningError: r.provisioningError,
    statusChangedAt: r.statusChangedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
