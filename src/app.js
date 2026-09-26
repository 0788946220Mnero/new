import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { mediaRouters } from './media/media.routes.js';
import { menuRouters } from './menu/menu.routes.js';
import { requireRestaurantAuth } from './middleware/restaurantAuth.js';
import { stripTenantOverrides } from './middleware/tenant.js';
import { platformRouter } from './platform/platform.routes.js';
import { publicMenuRouter } from './publicMenu/publicMenu.routes.js';
import { restaurantAuthRouter } from './restaurantAuth/auth.routes.js';
import { signupRouter } from './signup/signup.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { usersRouter } from './users/users.routes.js';

/**
 * Builds the Express app. Dependencies are injected so tests can run without a database.
 */
export function createApp({ config, logger, clusters, platform, restaurant }) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url.startsWith('/health') },
    }),
  );

  app.use(helmet());

  const allowed = new Set(config.CORS_ORIGINS);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
      credentials: true,
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { success: false, message: 'Too many requests', code: 'RATE_LIMITED' },
    }),
  );

  app.use(stripTenantOverrides);

  app.use('/health', healthRouter({ clusters }));

  if (platform) {
    app.use('/api/platform', platformRouter(platform));
  }

  if (restaurant) {
    const requireAuth = requireRestaurantAuth({ tokens: restaurant.tokens, tenantManager: restaurant.tenantManager });
    app.use('/api/auth', restaurantAuthRouter({ ...restaurant, requireAuth }));
    app.use('/api/users', usersRouter({ usersService: restaurant.usersService, requireAuth }));
    if (restaurant.menuService) {
      const menu = menuRouters({ menuService: restaurant.menuService, requireAuth });
      app.use('/api/categories', menu.categories);
      app.use('/api/products', menu.products);
    }
    if (restaurant.media) {
      const m = mediaRouters({ ...restaurant, requireAuth });
      app.use('/api/products', m.products);
      app.use('/api/categories', m.categories);
      app.use('/api/settings', m.settings);
    }
    if (restaurant.signupService) {
      app.use('/api/signup', signupRouter(restaurant));
    }
    if (restaurant.publicMenu) {
      app.use('/api/public', publicMenuRouter({ publicMenu: restaurant.publicMenu }));
    }
    // Development-only local image storage.
    if (restaurant.media?.storage.kind === 'local') {
      app.use('/media', express.static(restaurant.media.storage.root, { fallthrough: false, maxAge: '1h', dotfiles: 'deny', index: false }));
    }
  }

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
