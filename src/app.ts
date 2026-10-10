import express from 'express';
import rateLimit from 'express-rate-limit';
import { errorHandler } from './errors.js';
import { iconRouter } from './icons.js';
import { router } from './routes.js';
import { wornRouter } from './worn.js';

export function createApp() {
  const app = express();
  // Railway sits in front: the client address comes in X-Forwarded-For
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // Custom icons carry their picture: a bigger body on that route only, everything else stays small
  app.use('/v1/icons', express.json({ limit: '2mb' }));
  app.use('/v1/worn', express.json({ limit: '64kb' }));
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Plenty for browsing, not for flooding
  app.use(
    '/v1',
    rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Slow down a little' } }),
  );
  app.use(
    '/v1/auth',
    rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many logins, try later' } }),
  );
  app.use('/v1', iconRouter);
  app.use('/v1', wornRouter);
  app.use('/v1', router);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(errorHandler);
  return app;
}
