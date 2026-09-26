import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { createEncryptor, sha256 } from '../src/auth/secrets.js';
import { AUDIENCES, createPlatformTokens } from '../src/auth/tokens.js';
import { base32Decode, base32Encode, totpAt, verifyTotp } from '../src/auth/totp.js';

describe('TOTP (RFC 6238)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  test('matches the RFC test vectors', () => {
    for (const [t, expected] of [[59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924'], [2000000000, '69279037']]) {
      assert.equal(totpAt(secret, Math.floor(t / 30), 8), expected);
    }
  });

  test('base32 round-trips', () => {
    const buf = randomBytes(20);
    assert.deepEqual(base32Decode(base32Encode(buf)), buf);
  });

  test('accepts ±1 step, rejects older codes and replays', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    assert.equal(verifyTotp(secret, totpAt(secret, step - 1), { now }), step - 1);
    assert.equal(verifyTotp(secret, totpAt(secret, step + 1), { now }), step + 1);
    assert.equal(verifyTotp(secret, totpAt(secret, step - 2), { now }), null);
    assert.equal(verifyTotp(secret, totpAt(secret, step), { now, lastUsedStep: step }), null);
    for (const bad of ['', '12345', '1234567', 'abcdef', null, 123456]) {
      assert.equal(verifyTotp(secret, bad, { now }), null);
    }
  });
});

describe('secrets', () => {
  test('AES-GCM round-trips and detects tampering', () => {
    const enc = createEncryptor(randomBytes(32).toString('base64'));
    const payload = enc.encrypt('JBSWY3DPEHPK3PXP');
    assert.equal(enc.decrypt(payload), 'JBSWY3DPEHPK3PXP');
    assert.notEqual(enc.encrypt('same'), enc.encrypt('same'), 'random IV per encryption');

    const parts = payload.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => enc.decrypt(parts.join('.')));
    assert.throws(() => createEncryptor(randomBytes(32).toString('base64')).decrypt(payload));
  });

  test('sha256 is stable hex', () => {
    assert.equal(sha256('abc').length, 64);
    assert.equal(sha256('abc'), sha256('abc'));
  });
});

describe('passwords', () => {
  test('Argon2id hashes verify and never contain the password', async () => {
    const h = await hashPassword('correct horse battery');
    assert.match(h, /^\$argon2id\$/);
    assert.ok(!h.includes('correct horse'));
    assert.equal(await verifyPassword(h, 'correct horse battery'), true);
    assert.equal(await verifyPassword(h, 'wrong'), false);
    assert.equal(await verifyPassword('garbage', 'x'), false);
    assert.equal(await verifyPassword(h, { $ne: 1 }), false);
  });
});

describe('platform tokens', () => {
  const secret = randomBytes(32).toString('hex');
  const tokens = createPlatformTokens({ secret });
  const user = { _id: 'u1', tokenVersion: 3 };

  test('audiences are enforced', () => {
    const access = tokens.signAccess(user);
    assert.equal(tokens.verify(access, AUDIENCES.PLATFORM).ver, 3);
    assert.equal(tokens.verify(access, AUDIENCES.PLATFORM_MFA), null);
    const challenge = tokens.signChallenge(user, AUDIENCES.PLATFORM_MFA);
    assert.equal(tokens.verify(challenge, AUDIENCES.PLATFORM), null);
  });

  test('rejects other secrets, alg=none and garbage', () => {
    const foreign = jwt.sign({ ver: 0 }, 'other-secret', { subject: 'u1', audience: 'platform', issuer: 'free-menu' });
    assert.equal(tokens.verify(foreign, AUDIENCES.PLATFORM), null);
    const none = jwt.sign({ ver: 0 }, '', { algorithm: 'none', subject: 'u1', audience: 'platform', issuer: 'free-menu' });
    assert.equal(tokens.verify(none, AUDIENCES.PLATFORM), null);
    assert.equal(tokens.verify('x.y.z', AUDIENCES.PLATFORM), null);
    assert.equal(tokens.verify({}, AUDIENCES.PLATFORM), null);
  });
});
