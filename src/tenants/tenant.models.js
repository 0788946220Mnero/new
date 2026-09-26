import mongoose from 'mongoose';

const { Schema } = mongoose;

// Nothing is ever created implicitly in a tenant database.
// Collections and indexes are created on purpose by createTenantCollections().
const base = { autoIndex: false, autoCreate: false, strict: true };

const localizedText = (max, required = false) =>
  new Schema(
    {
      ar: { type: String, trim: true, maxlength: max, required },
      en: { type: String, trim: true, maxlength: max },
    },
    { _id: false },
  );

const imageRef = new Schema(
  {
    url: { type: String, maxlength: 500 },
    publicId: { type: String, maxlength: 300 },
  },
  { _id: false },
);

const price = {
  type: Number,
  min: 0,
  max: 100_000,
  validate: {
    validator: (v) => v == null || Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6,
    message: 'price supports at most 3 decimal places',
  },
};

export const ROLES = Object.freeze(['Owner', 'Editor']);

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, trim: true, maxlength: 30 },
    passwordHash: { type: String, select: false },
    role: { type: String, enum: ROLES, required: true },
    permissions: { type: [String], default: [] },
    status: { type: String, enum: ['invited', 'active', 'disabled'], default: 'invited' },
    failedLoginCount: { type: Number, default: 0 },
    lockUntil: Date,
    lastLoginAt: Date,
    passwordChangedAt: Date,
    // Bumped on password set/change, access reset and disable: invalidates every issued access token.
    tokenVersion: { type: Number, default: 0 },
    // One-time password setup link (stored hashed). Consumed in Phase 4.
    setupTokenHash: { type: String, select: false },
    setupTokenExpiresAt: { type: Date, select: false },
  },
  { ...base, collection: 'users', timestamps: true },
);
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ role: 1 });
userSchema.index({ setupTokenHash: 1 }, { sparse: true });

const categorySchema = new Schema(
  {
    name: { type: localizedText(80, true), required: true },
    image: { type: imageRef, default: undefined },
    sortOrder: { type: Number, default: 0 },
    isVisible: { type: Boolean, default: true },
  },
  { ...base, collection: 'categories', timestamps: true },
);
categorySchema.index({ isVisible: 1, sortOrder: 1 });

const variantSchema = new Schema(
  {
    name: { type: localizedText(40, true), required: true },
    price: { ...price, required: true },
  },
  { _id: true },
);

const productSchema = new Schema(
  {
    categoryId: { type: Schema.Types.ObjectId, required: true, index: false },
    name: { type: localizedText(120, true), required: true },
    description: { type: localizedText(600), default: undefined },
    price: { ...price }, // display only; optional when variants carry prices
    variants: {
      type: [variantSchema],
      default: [],
      validate: { validator: (v) => v.length <= 10, message: 'at most 10 variants' },
    },
    badges: { type: [{ type: String, enum: ['new', 'popular', 'spicy'] }], default: [] },
    image: { type: imageRef, default: undefined },
    isAvailable: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { ...base, collection: 'products', timestamps: true },
);
productSchema.index({ categoryId: 1, sortOrder: 1 });
productSchema.index({ isAvailable: 1 });

const HEX = /^#[0-9a-fA-F]{6}$/;

// Single document with _id "main".
const settingsSchema = new Schema(
  {
    _id: { type: String, default: 'main' },
    info: {
      name: { type: String, trim: true, maxlength: 120 },
      phone: { type: String, trim: true, maxlength: 30 },
      whatsapp: { type: String, trim: true, maxlength: 30 },
      address: { type: String, trim: true, maxlength: 300 },
      social: {
        instagram: { type: String, trim: true, maxlength: 200 },
        facebook: { type: String, trim: true, maxlength: 200 },
        tiktok: { type: String, trim: true, maxlength: 200 },
      },
    },
    logo: { type: imageRef, default: undefined },
    banner: { type: imageRef, default: undefined },
    theme: {
      primaryColor: { type: String, match: HEX, default: '#1F2937' },
      secondaryColor: { type: String, match: HEX, default: '#F59E0B' },
      font: { type: String, maxlength: 60, default: 'Cairo' },
      layout: { type: String, enum: ['list', 'grid'], default: 'grid' },
      cardStyle: { type: String, maxlength: 30, default: 'default' },
      categoryNav: { type: String, maxlength: 30, default: 'tabs' },
    },
    language: { type: String, enum: ['ar', 'en', 'both'], default: 'ar' },
    hideUnavailableProducts: { type: Boolean, default: false },
  },
  { ...base, collection: 'settings', timestamps: true },
);

const auditLogSchema = new Schema(
  {
    userId: { type: String },
    action: { type: String, required: true, maxlength: 80 },
    resource: { type: String, maxlength: 40 },
    resourceId: { type: String, maxlength: 64 },
    ip: { type: String, maxlength: 64 },
    metadata: { type: Schema.Types.Mixed },
  },
  { ...base, collection: 'auditLogs', timestamps: { createdAt: true, updatedAt: false } },
);
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ resource: 1, resourceId: 1, createdAt: -1 });

const DEFINITIONS = [
  ['User', userSchema],
  ['Category', categorySchema],
  ['Product', productSchema],
  ['Settings', settingsSchema],
  ['AuditLog', auditLogSchema],
];

/** Returns the tenant models bound to this tenant database handle (compiled once per db). */
export function getTenantModels(db) {
  const models = {};
  for (const [name, schema] of DEFINITIONS) {
    models[name] = db.models[name] ?? db.model(name, schema);
  }
  return Object.freeze(models);
}

/** Creates the 5 tenant collections and their indexes. Idempotent. Used by provisioning. */
export async function createTenantCollections(db) {
  const models = getTenantModels(db);
  for (const model of Object.values(models)) {
    await model.createCollection();
    await model.createIndexes();
  }
  return models;
}
