import 'dotenv/config';
import { createApp } from './app.js';
import { createEncryptor } from './auth/secrets.js';
import { createPlatformTokens, createRestaurantTokens } from './auth/tokens.js';
import { ClusterConnections } from './config/database.js';
import { EnvError, loadEnv } from './config/env.js';
import { PlatformAuditService } from './platform/platformAudit.service.js';
import { PlatformAuthService } from './platform/platformAuth.service.js';
import { RestaurantAdminService } from './platform/restaurantAdmin.service.js';
import { RestaurantProvisioningService } from './provisioning/restaurantProvisioning.service.js';
import { RestaurantAuthService } from './restaurantAuth/restaurantAuth.service.js';
import { SessionService } from './restaurantAuth/sessions.service.js';
import { createCloudinaryStorage, createLocalStorage, disabledStorage } from './media/imageStorage.js';
import { MediaService } from './media/media.service.js';
import { MenuService } from './menu/menu.service.js';
import { SignupService } from './signup/signup.service.js';
import { PublicMenuService } from './publicMenu/publicMenu.service.js';
import { SettingsService } from './settings/settings.service.js';
import { UsersService } from './users/users.service.js';
import { createRegistryModels } from './registry/registry.models.js';
import { RegistryService } from './registry/registry.service.js';
import { TenantDatabaseManager } from './tenants/tenantDatabaseManager.js';
import { createLogger } from './utils/logger.js';

async function main() {
  let config;
  try {
    config = loadEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  });

  const clusters = new ClusterConnections({ uris: config.MONGODB_CLUSTERS, logger });
  const primary = await clusters.connect('primary');

  const registry = new RegistryService({
    models: createRegistryModels(primary, config.REGISTRY_DB_NAME),
  });
  await registry.ensureIndexes();
  logger.info({ registryDb: config.REGISTRY_DB_NAME }, 'Registry ready');

  const tenantManager = new TenantDatabaseManager({
    registry,
    clusters,
    registryDbName: config.REGISTRY_DB_NAME,
    cacheTtlMs: config.TENANT_CACHE_TTL_MS,
    logger,
  });

  const audit = new PlatformAuditService({ model: registry.models.PlatformAuditLog, logger });
  const sessions = new SessionService({ model: registry.models.Session, pepper: config.JWT_REFRESH_SECRET });
  const platform = {
    audit,
    authService: new PlatformAuthService({
      models: registry.models,
      tokens: createPlatformTokens({ secret: config.PLATFORM_JWT_SECRET }),
      encryptor: createEncryptor(config.MFA_ENCRYPTION_KEY),
      audit,
      mfaRequired: config.platformMfaRequired,
    }),
    provisioning: new RestaurantProvisioningService({
      registryModels: registry.models,
      clusters,
      tenantManager,
      audit,
      logger,
      dashboardUrl: config.DASHBOARD_URL,
      sessions,
    }),
    restaurantAdmin: new RestaurantAdminService({
      registryModels: registry.models,
      clusters,
      tenantManager,
      audit,
      sessions,
    }),
  };

  const storage =
    config.mediaStorage === 'cloudinary'
      ? createCloudinaryStorage({
          cloudName: config.CLOUDINARY_CLOUD_NAME,
          apiKey: config.CLOUDINARY_API_KEY,
          apiSecret: config.CLOUDINARY_API_SECRET,
        })
      : config.mediaStorage === 'local'
        ? createLocalStorage({ dir: config.LOCAL_MEDIA_DIR })
        : disabledStorage;
  logger.info({ storage: storage.kind }, 'Image storage');
  if (!config.platformMfaRequired) {
    logger.warn('Super Admin MFA is NOT required (PLATFORM_MFA_REQUIRED=false)');
  }

  const publicMenu = new PublicMenuService({ tenantManager, storage });
  const onChange = (restaurantId) => publicMenu.invalidate(restaurantId);
  const media = new MediaService({ storage, registryModels: registry.models, logger, onChange });

  const restaurantTokens = createRestaurantTokens({ secret: config.JWT_ACCESS_SECRET });
  const restaurantAuthService = new RestaurantAuthService({
    registryModels: registry.models,
    tenantManager,
    sessions,
    tokens: restaurantTokens,
    logger,
  });
  const restaurant = {
    tokens: restaurantTokens,
    tenantManager,
    cookieSecure: config.cookieSecure,
    authService: restaurantAuthService,
    signupService: new SignupService({
      provisioning: platform.provisioning,
      authService: restaurantAuthService,
      trialDays: config.TRIAL_DAYS,
      enabled: config.selfSignupEnabled,
    }),
    usersService: new UsersService({
      registryModels: registry.models,
      sessions,
      dashboardUrl: config.DASHBOARD_URL,
      logger,
    }),
    menuService: new MenuService({ registryModels: registry.models, logger, media, onChange }),
    settingsService: new SettingsService({ storage, logger, onChange }),
    media,
    publicMenu,
  };

  // Expired sessions are rejected on use; this only keeps the collection small.
  const purge = setInterval(() => {
    sessions
      .purgeExpired()
      .then((n) => n && logger.info({ purged: n }, 'Expired sessions purged'))
      .catch((err) => logger.warn({ err }, 'Session purge failed'));
  }, 60 * 60 * 1000);
  purge.unref();

  const app = createApp({ config, logger, clusters, platform, restaurant });
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'Server listening');
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(async () => {
      await clusters.closeAll();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    shutdown('unhandledRejection');
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
