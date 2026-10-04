import { FastifyInstance } from 'fastify';
import { register } from '../metrics.js';

export async function metricsRoutes(fastify: FastifyInstance) {
  fastify.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', register.contentType);
    const metrics = await register.metrics();
    return reply.send(metrics);
  });
}
