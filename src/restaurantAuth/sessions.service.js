import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // sliding: renewed on each refresh
const REUSE_GRACE_MS = 15_000; // two tabs refreshing at the same moment is not an attack

const safeEqual = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Refresh-token sessions with rotation and reuse detection.
 * Cookie value: "<sessionId>.<secret>". Each refresh replaces the secret.
 * Presenting an already-rotated secret (outside a short grace window) means the
 * token was stolen and replayed, so the whole session is revoked.
 */
export class SessionService {
  #Session;
  #pepper;
  #now;

  constructor({ model, pepper, now = () => Date.now() }) {
    this.#Session = model;
    this.#pepper = pepper;
    this.#now = now;
  }

  static parse(cookieValue) {
    if (typeof cookieValue !== 'string' || cookieValue.length > 200) return null;
    const parts = cookieValue.split('.');
    if (parts.length !== 2) return null;
    const [sessionId, secret] = parts;
    if (!/^[\w-]{22}$/.test(sessionId) || !/^[\w-]{43}$/.test(secret)) return null;
    return { sessionId, secret };
  }

  #hash(secret) {
    return createHmac('sha256', this.#pepper).update(secret).digest('hex');
  }

  async create({ restaurantId, userId, ip, userAgent }) {
    const sessionId = randomBytes(16).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const now = this.#now();
    const expiresAt = new Date(now + SESSION_TTL_MS);
    await this.#Session.create({
      sessionId,
      restaurantId,
      userId: String(userId),
      tokenHash: this.#hash(secret),
      expiresAt,
      lastUsedAt: new Date(now),
      ip,
      userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 300) : undefined,
    });
    return { sessionId, cookieValue: `${sessionId}.${secret}`, expiresAt };
  }

  /**
   * @returns {{status:'rotated', session, cookieValue, expiresAt} | {status:'grace', session} |
   *           {status:'reuse', session} | {status:'invalid'}}
   */
  async rotate(cookieValue) {
    const parsed = SessionService.parse(cookieValue);
    if (!parsed) return { status: 'invalid' };
    const now = this.#now();

    const session = await this.#Session.findOne({ sessionId: parsed.sessionId }).lean();
    if (!session || session.expiresAt.getTime() <= now) return { status: 'invalid' };

    const presented = this.#hash(parsed.secret);

    if (safeEqual(presented, session.tokenHash)) {
      const secret = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now + SESSION_TTL_MS);
      const res = await this.#Session.updateOne(
        { sessionId: parsed.sessionId, tokenHash: presented },
        {
          $set: {
            tokenHash: this.#hash(secret),
            previousTokenHash: presented,
            rotatedAt: new Date(now),
            lastUsedAt: new Date(now),
            expiresAt,
          },
        },
      );
      if (res.modifiedCount === 1) {
        return { status: 'rotated', session, cookieValue: `${parsed.sessionId}.${secret}`, expiresAt };
      }
      // Lost a race with a concurrent refresh of the same cookie.
      const current = await this.#Session.findOne({ sessionId: parsed.sessionId }).lean();
      if (current && safeEqual(presented, current.previousTokenHash) && now - current.rotatedAt.getTime() < REUSE_GRACE_MS) {
        return { status: 'grace', session: current };
      }
      return { status: 'invalid' };
    }

    if (safeEqual(presented, session.previousTokenHash)) {
      if (session.rotatedAt && now - session.rotatedAt.getTime() < REUSE_GRACE_MS) {
        return { status: 'grace', session };
      }
      await this.#Session.deleteOne({ sessionId: parsed.sessionId });
      return { status: 'reuse', session };
    }

    return { status: 'invalid' };
  }

  async revoke(sessionId) {
    if (typeof sessionId !== 'string') return;
    await this.#Session.deleteOne({ sessionId });
  }

  async revokeAllForUser(restaurantId, userId, { except } = {}) {
    const filter = { restaurantId, userId: String(userId) };
    if (except) filter.sessionId = { $ne: except };
    await this.#Session.deleteMany(filter);
  }

  async revokeAllForRestaurant(restaurantId) {
    await this.#Session.deleteMany({ restaurantId });
  }

  async purgeExpired() {
    const res = await this.#Session.deleteMany({ expiresAt: { $lte: new Date(this.#now()) } });
    return res.deletedCount ?? 0;
  }
}
