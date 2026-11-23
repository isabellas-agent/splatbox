import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp(config, { logger: true });
await app.listen({ port: config.port, host: config.host });
if (config.auth) app.log.info(`Basic auth enabled (user "${config.auth.user}", readonly=${config.auth.readonly})`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
