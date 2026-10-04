import { buildApp } from './app.js';
import { config } from './config.js';
import { runMigrations, pool } from './db.js';
import { logger } from './logger.js';

async function start() {
  try {
    logger.info({ port: config.port, env: config.nodeEnv }, 'Starting Seat Reservation Service...');

    // Execute schema migrations
    await runMigrations();

    const app = buildApp();

    await app.listen({ port: config.port, host: config.host });
    logger.info(`Server listening on http://${config.host}:${config.port}`);

    // Graceful shutdown handling
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal. Closing gracefully...');
      try {
        await app.close();
        await pool.end();
        logger.info('Clean shutdown completed.');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    logger.fatal({ err }, 'Failed to start application');
    process.exit(1);
  }
}

start();
