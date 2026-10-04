import { FastifyInstance } from 'fastify';
import { checkDbHealth } from '../db.js';

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health/live', async (_req, reply) => {
    return reply.status(200).send({ status: 'live' });
  });

  fastify.get('/health/ready', async (_req, reply) => {
    const isDbReady = await checkDbHealth();
    if (!isDbReady) {
      return reply.status(503).send({
        status: 'down',
        database: 'unreachable',
      });
    }
    return reply.status(200).send({
      status: 'ready',
      database: 'connected',
    });
  });
}
