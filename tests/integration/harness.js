import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { createEncryptor } from '../../src/auth/secrets.js';
import { createPlatformTokens, createRestaurantTokens } from '../../src/auth/tokens.js';
import { timeStep, totpAt } from '../../src/auth/totp.js';
import { ClusterConnections } from '../../src/config/database.js';
import { PlatformAuditService } from '../../src/platform/platformAudit.service.js';
import { PlatformAuthService } from '../../src/platform/platformAuth.service.js';
import { RestaurantAdminService } from '../../src/platform/restaurantAdmin.service.js';
import { RestaurantProvisioningService } from '../../src/provisioning/restaurantProvisioning.service.js';
import { RestaurantAuthService } from '../../src/restaurantAuth/restaurantAuth.service.js';
import { SessionService } from '../../src/restaurantAuth/sessions.service.js';
import { createMemoryStorage } from '../../src/media/imageStorage.js';
import { MediaService } from '../../src/media/media.service.js';
import { MenuService } from '../../src/menu/menu.service.js';
import { SignupService } from '../../src/signup/signup.service.js';
import { PublicMenuService } from '../../src/publicMenu/publicMenu.service.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import { UsersService } from '../../src/users/users.service.js';
import { createRegistryModels } from '../../src/registry/registry.models.js';
import { RegistryService } from '../../src/registry/registry.service.js';
import { TenantDatabaseManager } from '../../src/tenants/tenantDatabaseManager.js';
import { silentLogger } from '../helpers.js';

/**
 * Real database for integration tests:
 *  - TEST_MONGODB_URI if set (never point this at production data),
 *  - otherwise an in-memory MongoDB (downloaded once by mongodb-memory-server).
 * Everything is created under a random registry name and dropped afterwards.
 */
export async function startHarness({ mfaRequired = true, signupEnabled = true } = {}) {
  let uri = process.env.TEST_MONGODB_URI;
  let memoryServer;
  if (!uri) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create();
    uri = memoryServer.getUri();
  }

  const registryDbName = `test_registry_${randomBytes(4).toString('hex')}`;
  const clusters = new ClusterConnections({ uris: { primary: uri }, logger: silentLogger });
  const primary = await clusters.connect('primary');
  const registry = new RegistryService({ models: createRegistryModels(primary, registryDbName) });
  await registry.ensureIndexes();

  const clock = {
    t: Date.now(),
    now() {
      return this.t;
    },
    advance(ms) {
      this.t += ms;
    },
  };

  const tenantManager = new TenantDatabaseManager({
    registry,
    clusters,
    registryDbName,
    logger: silentLogger,
    now: () => clock.now(),
  });

  const platformSecret = randomBytes(32).toString('base64url');
  const audit = new PlatformAuditService({ model: registry.models.PlatformAuditLog, logger: silentLogger });
  const hooks = {};
  const sessions = new SessionService({
    model: registry.models.Session,
    pepper: randomBytes(32).toString('hex'),
    now: () => clock.now(),
  });
  const storage = createMemoryStorage();
  const publicMenu = new PublicMenuService({ tenantManager, storage });
  const onChange = (restaurantId) => publicMenu.invalidate(restaurantId);
  const media = new MediaService({ storage, registryModels: registry.models, logger: silentLogger, onChange });
  const restaurantSecret = randomBytes(32).toString('base64url');
  const restaurantTokens = createRestaurantTokens({ secret: restaurantSecret });
  const platform = {
    audit,
    authRateLimit: 10_000,
    authService: new PlatformAuthService({
      models: registry.models,
      tokens: createPlatformTokens({ secret: platformSecret }),
      encryptor: createEncryptor(randomBytes(32).toString('base64')),
      audit,
      mfaRequired,
      now: () => clock.now(),
    }),
    provisioning: new RestaurantProvisioningService({
      registryModels: registry.models,
      clusters,
      tenantManager,
      audit,
      logger: silentLogger,
      dashboardUrl: 'https://admin.example.com',
      sessions,
      hooks,
      now: () => clock.now(),
    }),
    restaurantAdmin: new RestaurantAdminService({
      registryModels: registry.models,
      clusters,
      tenantManager,
      audit,
      sessions,
      now: () => clock.now(),
    }),
  };

  const restaurant = {
    tokens: restaurantTokens,
    tenantManager,
    cookieSecure: false,
    authRateLimit: 10_000,
    authService: new RestaurantAuthService({
      registryModels: registry.models,
      tenantManager,
      sessions,
      tokens: restaurantTokens,
      logger: silentLogger,
      now: () => clock.now(),
    }),
    usersService: new UsersService({
      registryModels: registry.models,
      sessions,
      dashboardUrl: 'https://admin.example.com',
      logger: silentLogger,
      now: () => clock.now(),
    }),
    menuService: new MenuService({ registryModels: registry.models, logger: silentLogger, media, onChange }),
    settingsService: new SettingsService({ storage, logger: silentLogger, onChange }),
    media,
    publicMenu,
    signupRateLimit: 10_000,
  };
  restaurant.signupService = new SignupService({
    provisioning: platform.provisioning,
    authService: restaurant.authService,
    trialDays: 7,
    enabled: signupEnabled,
  });

  const app = createApp({
    config: { TRUST_PROXY: 0, CORS_ORIGINS: [] },
    logger: silentLogger,
    clusters,
    platform,
    restaurant,
  });

  const h = {
    storage,
    sessions,
    restaurantSecret,
    app,
    clock,
    hooks,
    primary,
    registry,
    models: registry.models,
    tenantManager,
    platformSecret,

    tenantDb(databaseName) {
      return primary.useDb(databaseName, { useCache: true });
    },

    async databaseNames() {
      const { databases } = await primary.db.admin().listDatabases({ nameOnly: true });
      return databases.map((d) => d.name);
    },

    async seedSuperAdmin(email, password) {
      await registry.models.PlatformUser.create({
        email,
        name: 'Test Admin',
        role: 'SuperAdmin',
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
      });
    },

    code(secret) {
      return totpAt(secret, timeStep(clock.now()));
    },

    /** Full first login: password -> MFA enrollment -> forced password change. */
    async enrollSuperAdmin(email, password, newPassword) {
      const login = await request(app).post('/api/platform/auth/login').send({ email, password });
      const { challengeToken, mfaSecret } = login.body.data;
      const setup = await request(app)
        .post('/api/platform/auth/mfa/setup')
        .send({ challengeToken, code: h.code(mfaSecret) });
      const changed = await request(app)
        .post('/api/platform/auth/change-password')
        .set('Authorization', `Bearer ${setup.body.data.accessToken}`)
        .send({ currentPassword: password, newPassword });
      return { mfaSecret, token: changed.body.data.accessToken, setupToken: setup.body.data.accessToken };
    },

    /** Normal login for an enrolled admin (advances the clock so each login uses a fresh TOTP step). */
    async login(email, password, mfaSecret) {
      clock.advance(30_000);
      const login = await request(app).post('/api/platform/auth/login').send({ email, password });
      const verify = await request(app)
        .post('/api/platform/auth/mfa/verify')
        .send({ challengeToken: login.body.data.challengeToken, code: h.code(mfaSecret) });
      return verify.body.data.accessToken;
    },

    restaurantToken(restaurantId) {
      return jwt.sign({ restaurantId, role: 'Owner' }, randomBytes(32).toString('hex'), {
        subject: 'user1',
        audience: 'restaurant',
        issuer: 'free-menu',
      });
    },

    async stop() {
      try {
        const records = await registry.models.Restaurant.find({}, { databaseName: 1 }).lean();
        for (const r of records) await primary.useDb(r.databaseName).dropDatabase().catch(() => {});
        await primary.useDb(registryDbName).dropDatabase().catch(() => {});
      } finally {
        await clusters.closeAll();
        await memoryServer?.stop();
      }
    },
  };
  return h;
}
