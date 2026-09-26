// Creates the primary Super Admin from SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD.
//
//   npm run seed:super-admin                 create if missing (never overwrites)
//   npm run seed:super-admin -- --reset-password   set password from .env again (forces change on login)
//   npm run seed:super-admin -- --reset-mfa        remove MFA so it can be enrolled again (lost phone)
//
// Both resets sign out every existing session.
import 'dotenv/config';
import { hashPassword } from '../src/auth/password.js';
import { ClusterConnections } from '../src/config/database.js';
import { loadEnv } from '../src/config/env.js';
import { createRegistryModels } from '../src/registry/registry.models.js';

const args = new Set(process.argv.slice(2));
const config = loadEnv();
const clusters = new ClusterConnections({ uris: config.MONGODB_CLUSTERS });

try {
  const primary = await clusters.connect('primary');
  const { PlatformUser, PlatformAuditLog } = createRegistryModels(primary, config.REGISTRY_DB_NAME);
  await PlatformUser.createCollection();
  await PlatformUser.createIndexes();

  const email = config.SUPER_ADMIN_EMAIL;
  const existing = await PlatformUser.findOne({ email });
  const needsPassword = !existing || args.has('--reset-password');

  if (needsPassword && !config.SUPER_ADMIN_PASSWORD) {
    throw new Error('SUPER_ADMIN_PASSWORD is not set in .env');
  }

  if (!existing) {
    await PlatformUser.create({
      email,
      name: 'Super Admin',
      role: 'SuperAdmin',
      passwordHash: await hashPassword(config.SUPER_ADMIN_PASSWORD),
      mustChangePassword: true,
    });
    await PlatformAuditLog.create({ actorEmail: 'system', action: 'platform.super_admin_seeded', metadata: { email } });
    console.log(`✔ Super Admin ${email} created. You will be asked to set up MFA and change the password on first login.`);
  } else {
    const $set = {};
    const $unset = {};
    if (args.has('--reset-password')) {
      Object.assign($set, {
        passwordHash: await hashPassword(config.SUPER_ADMIN_PASSWORD),
        mustChangePassword: true,
        failedLoginCount: 0,
      });
      $unset.lockUntil = 1;
    }
    if (args.has('--reset-mfa')) {
      $set['mfa.enabled'] = false;
      $set['mfa.lastUsedStep'] = 0;
      $unset['mfa.secretEncrypted'] = 1;
      $unset['mfa.pendingSecretEncrypted'] = 1;
    }
    if (!Object.keys($set).length) {
      console.log(`ℹ Super Admin ${email} already exists. Nothing changed.`);
    } else {
      await PlatformUser.updateOne({ _id: existing._id }, { $set, $unset, $inc: { tokenVersion: 1 } });
      const actions = [...args].filter((a) => a.startsWith('--reset')).join(', ');
      await PlatformAuditLog.create({ actorEmail: 'system', action: 'platform.super_admin_reset', metadata: { email, actions } });
      console.log(`✔ Super Admin ${email} updated (${actions}). All sessions signed out.`);
    }
  }
  console.log('ℹ You can now remove SUPER_ADMIN_PASSWORD from .env.');
} catch (err) {
  console.error('✘', err.message);
  process.exitCode = 1;
} finally {
  await clusters.closeAll();
}
