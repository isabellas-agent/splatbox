import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { registerAuth } from './auth.js';
import { Store, HttpError } from './store.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self' blob: 'unsafe-inline' 'unsafe-eval'",
  "script-src-elem 'self' blob: 'unsafe-inline' 'unsafe-eval'",
  "worker-src 'self' blob: data:",
  "connect-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

export async function buildApp(config, { logger = false } = {}) {
  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });
  const store = new Store(config.dataDir, config.maxUploadBytes);
  await store.init();

  registerAuth(app, config.auth);

  app.addHook('onSend', async (_req, reply) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
  });

  // Raw streaming bodies for uploads
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  app.setErrorHandler((err, _req, reply) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) app.log.error(err);
    reply.code(status).send(status >= 500 ? 'Internal error' : err.message);
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/config', async () => ({
    auth: !!config.auth,
    authReadonly: !!config.auth?.readonly,
    maxUploadBytes: config.maxUploadBytes,
  }));

  app.get('/api/collections', async () => store.list());
  app.post('/api/collections', async (req, reply) => reply.code(201).send(await store.create(req.body?.name)));
  app.patch('/api/collections/:id', async (req) => store.rename(req.params.id, req.body?.name));
  app.delete('/api/collections/:id', async (req, reply) => {
    await store.remove(req.params.id);
    return reply.code(204).send();
  });
  app.put('/api/collections/:id/assets/:filename', async (req) => {
    if (!req.body?.pipe) throw new HttpError(415, 'Upload must use Content-Type: application/octet-stream');
    return store.putAsset(req.params.id, req.params.filename, req.body);
  });
  app.delete('/api/collections/:id/assets', async (req) => store.deleteAssets(req.params.id, req.body?.paths));
  app.post('/api/collections/:id/rescan', async (req) => store.rescan(req.params.id, req.query.apply === '1'));

  // Collection files (manifest + assets) with Range/ETag support
  await app.register(fastifyStatic, {
    root: store.root,
    prefix: '/files/collections/',
    decorateReply: false,
    dotfiles: 'deny',
    cacheControl: false,
    setHeaders: (reply) => reply.header('Cache-Control', 'public, max-age=0, must-revalidate'),
  });

  // Web app
  if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      prefix: '/',
      wildcard: true,
      setHeaders: (reply, p) => {
        reply.header(
          'Cache-Control',
          p.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  } else {
    app.log.warn(`Web dir ${config.webDir} not found; serving API only`);
  }

  return app;
}
