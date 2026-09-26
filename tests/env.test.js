import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EnvError, loadEnv } from '../src/config/env.js';

const valid = {
  MONGODB_URI: 'mongodb+srv://user:SuperSecretPass@cluster0.example.mongodb.net',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  PLATFORM_JWT_SECRET: 'c'.repeat(40),
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('loadEnv', () => {
  test('accepts a minimal valid environment and applies defaults', () => {
    const env = loadEnv(valid);
    assert.equal(env.PORT, 4000);
    assert.equal(env.REGISTRY_DB_NAME, 'restaurant_registry');
    assert.equal(env.SUPER_ADMIN_EMAIL, 'ninja@mero.com');
    assert.deepEqual(env.CORS_ORIGINS, []);
    assert.deepEqual({ ...env.MONGODB_CLUSTERS }, { primary: valid.MONGODB_URI });
    assert.ok(Object.isFrozen(env));
  });

  test('treats empty values as unset', () => {
    const env = loadEnv({ ...valid, SUPER_ADMIN_PASSWORD: '', CLOUDINARY_API_KEY: '' });
    assert.equal(env.SUPER_ADMIN_PASSWORD, undefined);
  });

  test('rejects missing MONGODB_URI', () => {
    const { MONGODB_URI, ...rest } = valid;
    assert.throws(() => loadEnv(rest), EnvError);
  });

  test('rejects short secrets without printing their values', () => {
    try {
      loadEnv({ ...valid, JWT_ACCESS_SECRET: 'short-secret-value' });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof EnvError);
      assert.match(err.message, /JWT_ACCESS_SECRET/);
      assert.doesNotMatch(err.message, /short-secret-value/);
    }
  });

  test('rejects reused JWT secrets', () => {
    assert.throws(
      () => loadEnv({ ...valid, PLATFORM_JWT_SECRET: valid.JWT_ACCESS_SECRET }),
      /must all be different/,
    );
  });

  test('requires a 32-byte MFA_ENCRYPTION_KEY', () => {
    assert.throws(() => loadEnv({ ...valid, MFA_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }), /MFA_ENCRYPTION_KEY/);
  });

  test('rejects "admin" as the Super Admin identity', () => {
    assert.throws(() => loadEnv({ ...valid, SUPER_ADMIN_EMAIL: 'admin@mero.com' }), /admin/);
  });

  test('requires CORS_ORIGINS in production and validates each origin', () => {
    assert.throws(() => loadEnv({ ...valid, NODE_ENV: 'production' }), /CORS_ORIGINS/);
    assert.throws(() => loadEnv({ ...valid, CORS_ORIGINS: 'https://a.com/path' }), /CORS_ORIGINS/);
    const env = loadEnv({ ...valid, NODE_ENV: 'production', CORS_ORIGINS: 'https://a.com, https://b.com' });
    assert.deepEqual(env.CORS_ORIGINS, ['https://a.com', 'https://b.com']);
  });

  test('never echoes the MongoDB URI in errors', () => {
    try {
      loadEnv({ ...valid, MONGODB_URI: 'http://user:SuperSecretPass@host' });
      assert.fail('should throw');
    } catch (err) {
      assert.doesNotMatch(err.message, /SuperSecretPass/);
    }
  });

  test('refresh cookie is Secure in production and cannot be turned off there', () => {
    const prod = { ...valid, NODE_ENV: 'production', CORS_ORIGINS: 'https://a.com' };
    assert.equal(loadEnv(prod).cookieSecure, true);
    assert.equal(loadEnv(valid).cookieSecure, false);
    assert.throws(() => loadEnv({ ...prod, COOKIE_SECURE: 'false' }), /COOKIE_SECURE/);
  });

  test('collects extra clusters from MONGODB_URI__<ID>', () => {
    const env = loadEnv({ ...valid, MONGODB_URI__EU2: 'mongodb+srv://x@eu2.example.net' });
    assert.equal(env.MONGODB_CLUSTERS.eu2, 'mongodb+srv://x@eu2.example.net');
    assert.throws(() => loadEnv({ ...valid, MONGODB_URI__EU2: 'nope' }), /MONGODB_URI__EU2/);
    assert.throws(() => loadEnv({ ...valid, MONGODB_URI__PRIMARY: 'mongodb://x' }), /reserved/);
  });
});
