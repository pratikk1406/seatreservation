import client from 'prom-client';

// Create a dedicated registry
export const register = new client.Registry();

// Enable collection of default Node.js runtime metrics (event loop lag, memory, GC)
client.collectDefaultMetrics({ register });

// Invariant & Domain Metrics
export const reservationsConfirmedTotal = new client.Counter({
  name: 'reservations_confirmed_total',
  help: 'Total number of successfully confirmed seat reservations',
  labelNames: ['show_id'],
  registers: [register],
});

export const reservationsDeclinedTotal = new client.Counter({
  name: 'reservations_declined_total',
  help: 'Total number of declined seat reservations partitioned by domain reason',
  labelNames: ['reason', 'show_id'],
  registers: [register],
});

export const idempotentReplaysTotal = new client.Counter({
  name: 'idempotent_replays_total',
  help: 'Total number of idempotent reservation retries replaying existing result',
  labelNames: ['show_id'],
  registers: [register],
});

export const seatsAvailableGauge = new client.Gauge({
  name: 'seats_available',
  help: 'Number of currently available seats per show',
  labelNames: ['show_id'],
  registers: [register],
});

export const reservationsCancelledTotal = new client.Counter({
  name: 'reservations_cancelled_total',
  help: 'Total number of successfully cancelled reservations',
  labelNames: ['show_id'],
  registers: [register],
});

// HTTP Observability Metrics
export const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests processed',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});
