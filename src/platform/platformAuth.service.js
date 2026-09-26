import { dummyVerify, hashPassword, passwordSchema, verifyPassword } from '../auth/password.js';
import { AUDIENCES, PLATFORM_ACCESS_TTL_SECONDS } from '../auth/tokens.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../auth/totp.js';
import { AppError } from '../utils/errors.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

const invalidCredentials = () =>
  new AppError(401, 'Invalid email or password', { code: 'INVALID_CREDENTIALS' });
const invalidChallenge = () =>
  new AppError(401, 'Login session expired. Please sign in again', { code: 'INVALID_CHALLENGE' });
const invalidCode = () =>
  new AppError(401, 'Invalid verification code', { code: 'INVALID_MFA_CODE' });
const locked = () =>
  new AppError(429, 'Too many failed attempts. Try again later', { code: 'ACCOUNT_LOCKED' });

/**
 * Super Admin authentication:
 *   1) POST login (email + password) -> short-lived challenge
 *   2a) first time: scan QR / enter key, then POST mfa/setup with a code
 *   2b) afterwards: POST mfa/verify with a code
 *   -> 30-minute access token (audience "platform")
 * Every request re-checks the user (status + tokenVersion), so logout, password
 * change and disabling take effect immediately.
 */
export class PlatformAuthService {
  #PlatformUser;
  #tokens;
  #encryptor;
  #audit;
  #now;

  constructor({ models, tokens, encryptor, audit, now = () => Date.now() }) {
    this.#PlatformUser = models.PlatformUser;
    this.#tokens = tokens;
    this.#encryptor = encryptor;
    this.#audit = audit;
    this.#now = now;
  }

  async login({ email, password, ip }) {
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const user = await this.#PlatformUser
      .findOne({ email: normalized })
      .select('+passwordHash');

    if (!user || !user.passwordHash || user.status !== 'active') {
      await dummyVerify(password);
      await this.#audit.log({ action: 'platform.login_failed', ip, metadata: { email: normalized, reason: 'unknown_or_disabled' } });
      throw invalidCredentials();
    }
    if (this.#isLocked(user)) throw locked();

    if (!(await verifyPassword(user.passwordHash, password))) {
      await this.#registerFailure(user._id);
      await this.#audit.log({ actor: this.#actor(user), action: 'platform.login_failed', ip, metadata: { reason: 'password' } });
      throw invalidCredentials();
    }

    if (user.mfa?.enabled) {
      return { step: 'mfa', challengeToken: this.#tokens.signChallenge(user, AUDIENCES.PLATFORM_MFA) };
    }

    // First login (or MFA was reset): issue a new pending secret to enroll.
    const secret = generateTotpSecret();
    await this.#PlatformUser.updateOne(
      { _id: user._id },
      { $set: { 'mfa.pendingSecretEncrypted': this.#encryptor.encrypt(secret) } },
    );
    return {
      step: 'mfa-setup',
      challengeToken: this.#tokens.signChallenge(user, AUDIENCES.PLATFORM_MFA_SETUP),
      mfaSecret: secret,
      otpauthUrl: otpauthUrl({ secret, account: user.email }),
    };
  }

  async completeMfaSetup({ challengeToken, code, ip }) {
    const user = await this.#userFromChallenge(challengeToken, AUDIENCES.PLATFORM_MFA_SETUP, '+mfa.pendingSecretEncrypted');
    if (!user.mfa?.pendingSecretEncrypted) throw invalidChallenge();

    const secret = this.#encryptor.decrypt(user.mfa.pendingSecretEncrypted);
    const step = verifyTotp(secret, code, { now: this.#now(), lastUsedStep: user.mfa.lastUsedStep ?? 0 });
    if (step === null) {
      await this.#registerFailure(user._id);
      throw invalidCode();
    }

    const res = await this.#PlatformUser.updateOne(
      { _id: user._id, 'mfa.pendingSecretEncrypted': user.mfa.pendingSecretEncrypted },
      {
        $set: {
          'mfa.enabled': true,
          'mfa.secretEncrypted': user.mfa.pendingSecretEncrypted,
          'mfa.lastUsedStep': step,
          failedLoginCount: 0,
          lastLoginAt: new Date(this.#now()),
        },
        $unset: { 'mfa.pendingSecretEncrypted': 1, lockUntil: 1 },
      },
    );
    if (res.modifiedCount !== 1) throw invalidChallenge();

    await this.#audit.log({ actor: this.#actor(user), action: 'platform.mfa_enabled', ip });
    await this.#audit.log({ actor: this.#actor(user), action: 'platform.login', ip });
    return this.#session(user);
  }

  async verifyMfa({ challengeToken, code, ip }) {
    const user = await this.#userFromChallenge(challengeToken, AUDIENCES.PLATFORM_MFA, '+mfa.secretEncrypted');
    if (!user.mfa?.enabled || !user.mfa.secretEncrypted) throw invalidChallenge();

    const secret = this.#encryptor.decrypt(user.mfa.secretEncrypted);
    const step = verifyTotp(secret, code, { now: this.#now(), lastUsedStep: user.mfa.lastUsedStep ?? 0 });
    if (step === null) {
      await this.#registerFailure(user._id);
      throw invalidCode();
    }

    // Atomic: only one request can consume this time step (blocks replay / races).
    const res = await this.#PlatformUser.updateOne(
      { _id: user._id, 'mfa.lastUsedStep': { $lt: step } },
      {
        $set: { 'mfa.lastUsedStep': step, failedLoginCount: 0, lastLoginAt: new Date(this.#now()) },
        $unset: { lockUntil: 1 },
      },
    );
    if (res.modifiedCount !== 1) throw invalidCode();

    await this.#audit.log({ actor: this.#actor(user), action: 'platform.login', ip });
    return this.#session(user);
  }

  /** Verifies an access token and returns the current user, or throws 401. */
  async authenticate(token) {
    const payload = this.#tokens.verify(token, AUDIENCES.PLATFORM);
    if (!payload) throw new AppError(401, 'Unauthorized', { code: 'UNAUTHORIZED' });

    const user = await this.#PlatformUser.findById(payload.sub).lean();
    if (!user || user.status !== 'active' || (user.tokenVersion ?? 0) !== payload.ver || !user.mfa?.enabled) {
      throw new AppError(401, 'Unauthorized', { code: 'UNAUTHORIZED' });
    }
    return {
      id: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role,
      mustChangePassword: Boolean(user.mustChangePassword),
    };
  }

  async changePassword({ userId, currentPassword, newPassword, ip }) {
    const parsed = passwordSchema.safeParse(newPassword);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0].message, { code: 'WEAK_PASSWORD' });
    }
    const user = await this.#PlatformUser.findById(userId).select('+passwordHash');
    if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new AppError(401, 'Current password is incorrect', { code: 'INVALID_CREDENTIALS' });
    }
    if (currentPassword === newPassword) {
      throw new AppError(400, 'New password must be different', { code: 'PASSWORD_REUSED' });
    }

    await this.#PlatformUser.updateOne(
      { _id: user._id },
      {
        $set: { passwordHash: await hashPassword(newPassword), mustChangePassword: false, passwordChangedAt: new Date(this.#now()) },
        $inc: { tokenVersion: 1 },
      },
    );
    const updated = await this.#PlatformUser.findById(user._id).lean();
    await this.#audit.log({ actor: this.#actor(user), action: 'platform.password_changed', ip });
    return this.#session(updated);
  }

  /** Signs out everywhere by invalidating every issued token. */
  async logout({ userId, email, ip }) {
    await this.#PlatformUser.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
    await this.#audit.log({ actor: { id: userId, email }, action: 'platform.logout', ip });
  }

  async #userFromChallenge(challengeToken, audience, select) {
    const payload = this.#tokens.verify(challengeToken, audience);
    if (!payload) throw invalidChallenge();
    const user = await this.#PlatformUser.findById(payload.sub).select(select);
    if (!user || user.status !== 'active' || (user.tokenVersion ?? 0) !== payload.ver) {
      throw invalidChallenge();
    }
    if (this.#isLocked(user)) throw locked();
    return user;
  }

  #isLocked(user) {
    return user.lockUntil && user.lockUntil.getTime() > this.#now();
  }

  async #registerFailure(userId) {
    await this.#PlatformUser.updateOne({ _id: userId }, { $inc: { failedLoginCount: 1 } });
    // Conditional update: no read-then-write race between concurrent failures.
    await this.#PlatformUser.updateOne(
      { _id: userId, failedLoginCount: { $gte: MAX_FAILED_ATTEMPTS } },
      { $set: { lockUntil: new Date(this.#now() + LOCK_MS), failedLoginCount: 0 } },
    );
  }

  #session(user) {
    return {
      accessToken: this.#tokens.signAccess(user),
      expiresIn: PLATFORM_ACCESS_TTL_SECONDS,
      mustChangePassword: Boolean(user.mustChangePassword),
      user: { email: user.email, name: user.name, role: user.role },
    };
  }

  #actor(user) {
    return { id: String(user._id), email: user.email };
  }
}
