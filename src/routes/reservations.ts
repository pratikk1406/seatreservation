import { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import { cancelReservation } from '../services/reservationService.js';

export async function reservationRoutes(fastify: FastifyInstance) {
  // Release / cancel reservation — POST /reservations/:id/cancel (authenticated user)
  fastify.post('/reservations/:id/cancel', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;

    const result = await cancelReservation(id, userId);
    return reply.status(result.statusCode).send(result.body);
  });
}
