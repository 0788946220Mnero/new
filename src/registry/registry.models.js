import mongoose from 'mongoose';
import {
  CLUSTER_ID_REGEX,
  DATABASE_NAME_REGEX,
  RESTAURANT_ID_REGEX,
  SLUG_REGEX,
} from '../tenants/tenantNaming.js';

const { Schema } = mongoose;
const base = { autoIndex: false, autoCreate: false, strict: true };

export const RESTAURANT_STATUSES = Object.freeze([
  'provisioning',
  'active',
  'failed',
  'suspended',
  'archived',
]);

const restaurantSchema = new Schema(
  {
    restaurantId: { type: String, required: true, match: RESTAURANT_ID_REGEX, immutable: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, lowercase: true, trim: true, match: SLUG_REGEX },
    databaseName: { type: String, required: true, match: DATABASE_NAME_REGEX, immutable: true },
    clusterId: { type: String, required: true, default: 'primary', match: CLUSTER_ID_REGEX },
    status: { type: String, enum: RESTAURANT_STATUSES, required: true, default: 'provisioning' },
    statusChangedAt: { type: Date },
    provisioningSteps: { type: Map, of: Date, default: () => new Map() },
    provisioningError: { type: String, maxlength: 2000 },
    contact: {
      phone: { type: String, trim: true, maxlength: 30 },
      email: { type: String, trim: true, lowercase: true, maxlength: 254 },
      address: { type: String, trim: true, maxlength: 300 },
    },
    limits: {
      maxProducts: { type: Number, min: 1, default: 300 },
      maxCategories: { type: Number, min: 1, default: 40 },
      maxImageSizeMB: { type: Number, min: 1, max: 20, default: 5 },
    },
    owner: {
      name: { type: String, trim: true, maxlength: 100 },
      email: { type: String, trim: true, lowercase: true, maxlength: 254 },
      phone: { type: String, trim: true, maxlength: 30 },
    },
    ownerUserId: { type: String },
    mediaFolder: { type: String, maxlength: 100 },
    notes: { type: String, maxlength: 2000 },
  },
  { ...base, collection: 'restaurants', timestamps: true },
);
restaurantSchema.index({ restaurantId: 1 }, { unique: true });
restaurantSchema.index({ slug: 1 }, { unique: true });
restaurantSchema.index({ databaseName: 1 }, { unique: true });
restaurantSchema.index({ status: 1, createdAt: -1 });
restaurantSchema.index({ 'owner.email': 1 });

// Login lookup only: email -> which restaurant database holds the user. No secrets here.
const userDirectorySchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    restaurantId: { type: String, required: true, match: RESTAURANT_ID_REGEX },
    userId: { type: String, required: true },
  },
  { ...base, collection: 'userDirectory', timestamps: true },
);
userDirectorySchema.index({ email: 1 }, { unique: true });
userDirectorySchema.index({ restaurantId: 1 });

const platformUserSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    name: { type: String, trim: true, maxlength: 100 },
    passwordHash: { type: String, select: false },
    role: { type: String, enum: ['SuperAdmin'], required: true, default: 'SuperAdmin' },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    mustChangePassword: { type: Boolean, default: true },
    // Bumped on logout / password change / MFA reset: invalidates every issued token.
    tokenVersion: { type: Number, default: 0 },
    mfa: {
      enabled: { type: Boolean, default: false },
      secretEncrypted: { type: String, select: false },
      pendingSecretEncrypted: { type: String, select: false },
      lastUsedStep: { type: Number, default: 0 }, // prevents TOTP code replay
    },
    failedLoginCount: { type: Number, default: 0 },
    lockUntil: Date,
    lastLoginAt: Date,
    passwordChangedAt: Date,
  },
  { ...base, collection: 'platformUsers', timestamps: true },
);
platformUserSchema.index({ email: 1 }, { unique: true });

const platformSettingSchema = new Schema(
  {
    key: { type: String, required: true, maxlength: 80 },
    value: { type: Schema.Types.Mixed },
  },
  { ...base, collection: 'platformSettings', timestamps: true },
);
platformSettingSchema.index({ key: 1 }, { unique: true });

const platformAuditLogSchema = new Schema(
  {
    actorId: { type: String },
    actorEmail: { type: String },
    action: { type: String, required: true, maxlength: 80 },
    resource: { type: String, maxlength: 40 },
    resourceId: { type: String, maxlength: 64 },
    restaurantId: { type: String },
    ip: { type: String, maxlength: 64 },
    metadata: { type: Schema.Types.Mixed },
  },
  { ...base, collection: 'platformAuditLogs', timestamps: { createdAt: true, updatedAt: false } },
);
platformAuditLogSchema.index({ createdAt: -1 });
platformAuditLogSchema.index({ restaurantId: 1, createdAt: -1 });
platformAuditLogSchema.index({ action: 1, createdAt: -1 });

// Restaurant user sessions (refresh tokens). Only an HMAC of the token is stored.
// Expiry is checked on every use; expired rows are purged periodically (no TTL index
// dependency, so behaviour is identical on every MongoDB-compatible server).
const sessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, maxlength: 64 },
    restaurantId: { type: String, required: true, match: RESTAURANT_ID_REGEX },
    userId: { type: String, required: true, maxlength: 64 },
    tokenHash: { type: String, required: true },
    previousTokenHash: { type: String },
    rotatedAt: { type: Date },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date },
    ip: { type: String, maxlength: 64 },
    userAgent: { type: String, maxlength: 300 },
  },
  { ...base, collection: 'sessions', timestamps: true },
);
sessionSchema.index({ sessionId: 1 }, { unique: true });
sessionSchema.index({ restaurantId: 1, userId: 1 });
sessionSchema.index({ expiresAt: 1 });

const DEFINITIONS = [
  ['Restaurant', restaurantSchema],
  ['Session', sessionSchema],
  ['UserDirectory', userDirectorySchema],
  ['PlatformUser', platformUserSchema],
  ['PlatformSetting', platformSettingSchema],
  ['PlatformAuditLog', platformAuditLogSchema],
];

export function createRegistryModels(connection, registryDbName) {
  const db = connection.useDb(registryDbName, { useCache: true });
  const models = {};
  for (const [name, schema] of DEFINITIONS) {
    models[name] = db.models[name] ?? db.model(name, schema);
  }
  return Object.freeze(models);
}
