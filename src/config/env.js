import { z } from 'zod';

const secret = z.string().min(32, 'must be at least 32 characters');

const mongoUri = z
  .string()
  .refine(
    (v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://'),
    'must start with mongodb:// or mongodb+srv://',
  );

const csvOrigins = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(
    z.array(
      z.string().refine((o) => {
        try {
          return new URL(o).origin === o;
        } catch {
          return false;
        }
      }, 'each origin must look like https://example.com (no path, no trailing slash)'),
    ),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),

  MONGODB_URI: mongoUri,
  REGISTRY_DB_NAME: z
    .string()
    .regex(/^[a-z][a-z0-9_]{2,40}$/, 'lowercase letters, digits and _ only')
    .default('restaurant_registry'),
  TENANT_CACHE_TTL_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),

  JWT_ACCESS_SECRET: secret,
  JWT_REFRESH_SECRET: secret,
  PLATFORM_JWT_SECRET: secret,
  // 32 random bytes, base64. Encrypts Super Admin MFA secrets at rest.
  MFA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes encoded as base64'),

  SUPER_ADMIN_EMAIL: z
    .string()
    .email()
    .transform((e) => e.toLowerCase())
    .refine((e) => e.split('@')[0] !== 'admin', 'must not use "admin" as the identity')
    .default('ninja@mero.com'),
  // Only needed when seeding the first Super Admin (Phase 3).
  SUPER_ADMIN_PASSWORD: z.string().min(12, 'must be at least 12 characters').optional(),

  // Required from Phase 8 (uploads).
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // Refresh-token cookie "Secure" flag. Defaults to true in production.
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),

  // Development only: where uploaded images are kept when Cloudinary is not configured.
  LOCAL_MEDIA_DIR: z.string().default('.media'),

  PUBLIC_MENU_URL: z.string().url().optional(),
  DASHBOARD_URL: z.string().url().optional(),
  CORS_ORIGINS: csvOrigins,
});

const EXTRA_CLUSTER_KEY = /^MONGODB_URI__([A-Z0-9_-]{1,32})$/;

export class EnvError extends Error {
  constructor(problems) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvError';
    this.problems = problems;
  }
}

/**
 * Parses and validates environment variables.
 * Error messages name the variable and the rule only — never the value.
 */
export function loadEnv(source = process.env) {
  // Treat empty strings ("KEY=") as "not set".
  const clean = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== '' && v !== undefined) clean[k] = v;
  }

  const parsed = schema.safeParse(clean);
  if (!parsed.success) {
    throw new EnvError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`),
    );
  }
  const env = parsed.data;
  const problems = [];

  const jwtSecrets = [env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET, env.PLATFORM_JWT_SECRET];
  if (new Set(jwtSecrets).size !== jwtSecrets.length) {
    problems.push('JWT_ACCESS_SECRET, JWT_REFRESH_SECRET and PLATFORM_JWT_SECRET must all be different');
  }
  if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.length === 0) {
    problems.push('CORS_ORIGINS: required in production');
  }

  const clusters = { primary: env.MONGODB_URI };
  for (const [key, value] of Object.entries(clean)) {
    const m = EXTRA_CLUSTER_KEY.exec(key);
    if (!m) continue;
    const id = m[1].toLowerCase();
    if (id === 'primary') {
      problems.push(`${key}: "primary" is reserved for MONGODB_URI`);
    } else if (!mongoUri.safeParse(value).success) {
      problems.push(`${key}: must start with mongodb:// or mongodb+srv://`);
    } else {
      clusters[id] = value;
    }
  }

  if (problems.length) throw new EnvError(problems);

  const cloudinaryKeys = [env.CLOUDINARY_CLOUD_NAME, env.CLOUDINARY_API_KEY, env.CLOUDINARY_API_SECRET];
  const cloudinarySet = cloudinaryKeys.filter(Boolean).length;
  if (cloudinarySet > 0 && cloudinarySet < 3) {
    problems.push('CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET must be set together');
    throw new EnvError(problems);
  }
  const mediaStorage = cloudinarySet === 3 ? 'cloudinary' : env.NODE_ENV === 'production' ? 'disabled' : 'local';

  const cookieSecure = env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production';
  if (env.NODE_ENV === 'production' && !cookieSecure) {
    throw new EnvError(['COOKIE_SECURE: must not be false in production']);
  }

  return Object.freeze({ ...env, cookieSecure, mediaStorage, MONGODB_CLUSTERS: Object.freeze(clusters) });
}
