import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/seat_reservation',
  defaultPerUserLimit: parseInt(process.env.DEFAULT_PER_USER_LIMIT || '4', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPoolMax: parseInt(process.env.DB_POOL_MAX || '50', 10),
  dbPoolIdleTimeoutMs: parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS || '10000', 10),
  dbConnectionTimeoutMs: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '5000', 10),
};
