import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { logger } from './logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: config.dbPoolIdleTimeoutMs,
  connectionTimeoutMillis: config.dbConnectionTimeoutMs,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database client error in pool');
});

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const migrationPath = path.resolve(__dirname, '../migrations/001_initial_schema.sql');
    
    // In case migration file is outside dist or in project root
    let sql: string;
    if (fs.existsSync(migrationPath)) {
      sql = fs.readFileSync(migrationPath, 'utf8');
    } else {
      const fallbackPath = path.resolve(process.cwd(), 'migrations/001_initial_schema.sql');
      sql = fs.readFileSync(fallbackPath, 'utf8');
    }

    logger.info('Running database migrations...');
    await client.query(sql);
    logger.info('Database migrations applied successfully.');
  } catch (error) {
    logger.error({ error }, 'Failed to run database migrations');
    throw error;
  } finally {
    client.release();
  }
}

export async function checkDbHealth(): Promise<boolean> {
  try {
    const res = await pool.query('SELECT 1 AS alive');
    return res.rows.length > 0 && res.rows[0].alive === 1;
  } catch (error) {
    logger.warn({ error }, 'Database health check failed');
    return false;
  }
}
