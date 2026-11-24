import { timingSafeEqual, createHash } from 'node:crypto';

const digest = (s) => createHash('sha256').update(s).digest();
const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));

/**
 * Optional HTTP Basic auth. When `auth.readonly` is set only mutating
 * requests (non GET/HEAD/OPTIONS) require credentials.
 */
export function registerAuth(app, auth) {
  if (!auth) return;
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/api/health' || req.url.startsWith('/api/health?')) return;
    if (auth.readonly && ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i >= 0) {
        const okUser = safeEqual(decoded.slice(0, i), auth.user);
        const okPass = safeEqual(decoded.slice(i + 1), auth.password);
        if (okUser && okPass) return;
      }
    }
    // Background requests (e.g. thumbnail uploads) must not pop up a login dialog
    if (!req.headers['x-splatbox-background']) {
      reply.header('WWW-Authenticate', 'Basic realm="splatbox", charset="UTF-8"');
    }
    return reply.code(401).send('Authentication required');
  });
}
