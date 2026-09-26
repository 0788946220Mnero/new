import { randomInt } from 'node:crypto';

// No 0/O or 1/I to avoid confusion when IDs are read aloud or typed.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ID_LENGTH = 8; // 32^8 ≈ 1.1e12 combinations

export const RESTAURANT_ID_REGEX = /^rest_[2-9A-HJ-NP-Z]{8}$/;
export const DATABASE_NAME_REGEX = /^restaurant_[2-9A-HJ-NP-Z]{8}$/;
export const CLUSTER_ID_REGEX = /^[a-z0-9_-]{1,32}$/;
// 3–50 chars, lowercase latin letters, digits and dashes, no leading/trailing dash.
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'assets', 'auth', 'dashboard', 'health', 'help',
  'login', 'logout', 'media', 'menu', 'platform', 'static', 'super-admin', 'support', 'www',
]);

export function generateRestaurantId() {
  let suffix = '';
  for (let i = 0; i < ID_LENGTH; i += 1) suffix += ALPHABET[randomInt(ALPHABET.length)];
  return `rest_${suffix}`;
}

export function isValidRestaurantId(value) {
  return typeof value === 'string' && RESTAURANT_ID_REGEX.test(value);
}

/** The database name is derived from restaurantId only — never from user input. */
export function databaseNameFor(restaurantId) {
  if (!isValidRestaurantId(restaurantId)) throw new Error('Invalid restaurantId');
  return `restaurant_${restaurantId.slice('rest_'.length)}`;
}

export function isValidDatabaseName(value) {
  return typeof value === 'string' && DATABASE_NAME_REGEX.test(value);
}

/** Returns a normalized slug, or null if it is not an acceptable public slug. */
export function normalizeSlug(value) {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase();
  if (!SLUG_REGEX.test(slug) || RESERVED_SLUGS.has(slug)) return null;
  return slug;
}
