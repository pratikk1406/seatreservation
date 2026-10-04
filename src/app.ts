import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import crypto from 'crypto';
import { logger } from './logger.js';
import { httpRequestDurationSeconds, httpRequestsTotal } from './metrics.js';
import { healthRoutes } from './routes/health.js';
import { metricsRoutes } from './routes/metrics.js';
import { showRoutes } from './routes/shows.js';
import { reservationRoutes } from './routes/reservations.js';

export function buildApp(): FastifyInstance {
  const app: FastifyInstance = fastify({
    loggerInstance: logger as any,
    genReqId: (req) => {
      const existing = req.headers['x-request-id'];
      if (typeof existing === 'string' && existing.trim()) {
        return existing.trim();
      }
      return crypto.randomUUID();
    },
    disableRequestLogging: true, // We implement structured access logging via hooks
  });

  // Enable CORS
  app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Track request timing & metrics
  app.addHook('onRequest', async (req) => {
    (req as any).startTime = process.hrtime();
  });

  app.addHook('onResponse', async (req, reply) => {
    const startTime = (req as any).startTime;
    let durationSeconds = 0;
    if (startTime) {
      const diff = process.hrtime(startTime);
      durationSeconds = diff[0] + diff[1] / 1e9;
    }

    const route = req.routeOptions.url || req.url;
    const method = req.method;
    const statusCode = reply.statusCode.toString();

    // Prometheus metric updates (skip /metrics itself to avoid self-pollution)
    if (!req.url.startsWith('/metrics')) {
      httpRequestDurationSeconds.observe({ method, route, status_code: statusCode }, durationSeconds);
      httpRequestsTotal.inc({ method, route, status_code: statusCode });
    }

    // Structured JSON access log
    req.log.info({
      requestId: req.id,
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(durationSeconds * 1000 * 100) / 100,
      userId: req.user?.id,
    }, 'HTTP Request processed');
  });

  // Global error handler
  app.setErrorHandler((error: any, req, reply) => {
    req.log.error({ error, reqId: req.id }, 'Unhandled request error');

    const statusCode = error.statusCode || 500;
    return reply.status(statusCode).send({
      error: statusCode >= 500 ? 'internal_server_error' : 'request_error',
      message: statusCode >= 500 ? 'An unexpected internal error occurred' : error.message,
      requestId: req.id,
    });
  });

  // Register domain routes
  app.register(healthRoutes);
  app.register(metricsRoutes);
  app.register(showRoutes);
  app.register(reservationRoutes);

  return app;
}
