import { Router } from 'express';

export function healthRouter({ clusters }) {
  const router = Router();

  // Liveness: the process is up.
  router.get('/', (_req, res) => {
    res.json({ success: true, status: 'ok' });
  });

  // Readiness: the primary database answers.
  router.get('/ready', async (req, res) => {
    try {
      await clusters.ping('primary');
      res.json({ success: true, status: 'ready' });
    } catch (err) {
      req.log?.warn({ err: { message: err.message } }, 'Readiness check failed');
      res.status(503).json({ success: false, message: 'Service unavailable', code: 'NOT_READY' });
    }
  });

  return router;
}
