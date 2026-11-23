import path from 'node:path';

const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

export function loadConfig(env = process.env) {
  const authUser = env.BASIC_AUTH_USER || '';
  const authPassword = env.BASIC_AUTH_PASSWORD || '';
  return {
    port: Number(env.PORT || 8080),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    webDir: path.resolve(env.WEB_DIR || '../web/dist'),
    maxUploadBytes: Math.floor(Number(env.MAX_UPLOAD_GB || 4) * 1024 ** 3),
    auth: authUser && authPassword
      ? { user: authUser, password: authPassword, readonly: bool(env.BASIC_AUTH_READONLY) }
      : null,
  };
}
