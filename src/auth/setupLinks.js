import { isValidRestaurantId } from '../tenants/tenantNaming.js';
import { randomToken, sha256 } from './secrets.js';

export const SETUP_LINK_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * One-time "set your password" link for a restaurant user (owner or employee).
 * Only the SHA-256 of the token is stored. The token travels in the URL fragment (#),
 * which browsers never send to servers, so it doesn't end up in any access log.
 */
export async function issueSetupLink({ User, userId, restaurantId, dashboardUrl, now = Date.now() }) {
  const token = randomToken(32);
  const expiresAt = new Date(now + SETUP_LINK_TTL_MS);
  const res = await User.updateOne(
    { _id: userId },
    { $set: { setupTokenHash: sha256(token), setupTokenExpiresAt: expiresAt } },
  );
  if (res.matchedCount !== 1) throw new Error('User not found while issuing setup link');

  const fragment = `setup-password#token=${restaurantId}.${token}`;
  const base = dashboardUrl?.replace(/\/+$/, '');
  return { setupUrl: base ? `${base}/${fragment}` : `/${fragment}`, setupExpiresAt: expiresAt };
}

/** "rest_XXXXXXXX.<secret>" -> { restaurantId, hash } or null. */
export function parseSetupToken(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const dot = raw.indexOf('.');
  if (dot < 0) return null;
  const restaurantId = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (!isValidRestaurantId(restaurantId) || !/^[\w-]{40,64}$/.test(secret)) return null;
  return { restaurantId, hash: sha256(secret) };
}
