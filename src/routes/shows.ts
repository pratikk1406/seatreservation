import { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import { createShow, getShowState } from '../services/showService.js';
import { reserveSeats } from '../services/reservationService.js';

export async function showRoutes(fastify: FastifyInstance) {
  // 1. Create a show — POST /shows (admin)
  fastify.post('/shows', async (request, reply) => {
    try {
      const body = request.body as any;
      if (!body) {
        return reply.status(400).send({ error: 'bad_request', message: 'Request body required' });
      }

      const show = await createShow({
        name: body.name,
        seats: body.seats,
        price_paise: body.price_paise,
        per_user_limit: body.per_user_limit,
      });

      return reply.status(201).send(show);
    } catch (err: any) {
      return reply.status(400).send({
        error: 'bad_request',
        message: err.message || 'Failed to create show',
      });
    }
  });

  // 2. Show state — GET /shows/:id
  fastify.get('/shows/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const showState = await getShowState(id);

    if (!showState) {
      return reply.status(404).send({
        error: 'not_found',
        message: 'Show not found',
      });
    }

    return reply.status(200).send(showState);
  });

  // 3. Reserve a seat — POST /shows/:id/reserve (authenticated user)
  fastify.post('/shows/:id/reserve', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;
    const body = (request.body || {}) as any;

    // Idempotency key can come from header or body
    const idempotencyKey =
      body.idempotency_key ||
      (request.headers['idempotency-key'] as string) ||
      (request.headers['x-idempotency-key'] as string);

    const seats = body.seats;

    const result = await reserveSeats({
      showId: id,
      userId,
      seats,
      idempotencyKey,
    });

    return reply.status(result.statusCode).send(result.body);
  });
}
