import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    env: config.nodeEnv,
    service: 'seat-reservation-service',
  },
});
