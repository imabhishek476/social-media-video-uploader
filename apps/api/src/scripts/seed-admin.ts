/**
 * Create the bootstrap admin from ADMIN_EMAIL / ADMIN_PASSWORD in .env.
 *   npm run seed:admin
 */
import { loadConfig } from '@shorts/config';
import { connectDatabase, disconnectDatabase } from '@shorts/database';
import { createLogger } from '@shorts/observability';
import { ensureBootstrapAdmin } from '../services/auth.service';

const config = loadConfig();
const logger = createLogger({ service: 'seed-admin', level: 'info', pretty: !config.isProduction });

if (!config.bootstrapAdmin) {
  logger.error('Set ADMIN_EMAIL and ADMIN_PASSWORD in .env first');
  process.exit(1);
}

await connectDatabase(config.mongoUri);
const result = await ensureBootstrapAdmin(config, logger);
logger.info({ email: config.bootstrapAdmin.email, result }, 'Admin seed finished');
await disconnectDatabase();
