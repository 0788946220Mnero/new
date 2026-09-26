import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';

// @node-rs/argon2 defaults: Argon2id, m=19456 KiB, t=2, p=1 (OWASP recommendation).
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters');

export function hashPassword(password) {
  return hash(password);
}

export async function verifyPassword(passwordHash, password) {
  if (typeof passwordHash !== 'string' || typeof password !== 'string') return false;
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash;
/** Spends the same time as a real check, so unknown emails can't be detected by timing. */
export async function dummyVerify(password) {
  dummyHash ??= await hash('timing-equalizer-not-a-real-password');
  await verifyPassword(dummyHash, typeof password === 'string' ? password : '');
  return false;
}
