import jwt from 'jsonwebtoken';

const ISSUER = 'free-menu';
const ALG = 'HS256';

export const AUDIENCES = Object.freeze({
  PLATFORM: 'platform',
  PLATFORM_MFA: 'platform-mfa',
  PLATFORM_MFA_SETUP: 'platform-mfa-setup',
  RESTAURANT: 'restaurant',
});

export const PLATFORM_ACCESS_TTL_SECONDS = 30 * 60;
export const RESTAURANT_ACCESS_TTL_SECONDS = 10 * 60;
const CHALLENGE_TTL_SECONDS = 5 * 60;

/**
 * Platform (Super Admin) tokens use their own secret AND their own audiences.
 * A restaurant token can never verify here, and a login challenge can never be used as an access token.
 */
export function createPlatformTokens({ secret }) {
  const sign = (user, audience, expiresIn) =>
    jwt.sign({ ver: user.tokenVersion ?? 0 }, secret, {
      subject: String(user._id),
      audience,
      issuer: ISSUER,
      expiresIn,
      algorithm: ALG,
    });

  return {
    signAccess: (user) => sign(user, AUDIENCES.PLATFORM, PLATFORM_ACCESS_TTL_SECONDS),
    signChallenge: (user, audience) => sign(user, audience, CHALLENGE_TTL_SECONDS),
    /** Returns the payload or null. */
    verify(token, audience) {
      if (typeof token !== 'string' || token.length > 2048) return null;
      try {
        return jwt.verify(token, secret, { audience, issuer: ISSUER, algorithms: [ALG] });
      } catch {
        return null;
      }
    },
  };
}

/**
 * Restaurant user access tokens: separate secret (JWT_ACCESS_SECRET) and audience.
 * Short-lived (10 min); the refresh cookie renews them. The user record is re-checked
 * on every request, so disabling a user or changing a password takes effect at once.
 */
export function createRestaurantTokens({ secret }) {
  return {
    signAccess({ userId, restaurantId, role, sessionId, tokenVersion = 0 }) {
      return jwt.sign({ restaurantId, role, sid: sessionId, ver: tokenVersion }, secret, {
        subject: String(userId),
        audience: AUDIENCES.RESTAURANT,
        issuer: ISSUER,
        expiresIn: RESTAURANT_ACCESS_TTL_SECONDS,
        algorithm: ALG,
      });
    },
    verify(token) {
      if (typeof token !== 'string' || token.length > 2048) return null;
      try {
        return jwt.verify(token, secret, { audience: AUDIENCES.RESTAURANT, issuer: ISSUER, algorithms: [ALG] });
      } catch {
        return null;
      }
    },
  };
}
