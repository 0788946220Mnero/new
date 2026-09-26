import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** AES-256-GCM encryption for small secrets at rest (e.g. MFA seeds). Format: v1.iv.tag.ciphertext */
export function createEncryptor(base64Key) {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');

  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
    },
    decrypt(payload) {
      const [version, iv, tag, ct] = String(payload).split('.');
      if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Malformed encrypted payload');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ct, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/** One-time tokens are stored as SHA-256 hashes; the raw token only ever lives in the link. */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
