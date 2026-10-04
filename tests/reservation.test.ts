import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { runMigrations, pool } from '../src/db.js';
import { FastifyInstance } from 'fastify';

describe('Seat Reservation Service - Concurrency & Invariant Suite', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/seat_reservation';
    await runMigrations();
    app = buildApp();
    await app.ready();
  });

  beforeEach(async () => {
    // Clean database tables to guarantee hermetic test isolation
    await pool.query('TRUNCATE shows, seats, reservations, reservation_seats, idempotency_keys CASCADE');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('Health checks respond properly', async () => {
    const liveRes = await app.inject({
      method: 'GET',
      url: '/health/live',
    });
    expect(liveRes.statusCode).toBe(200);
    expect(JSON.parse(liveRes.payload)).toEqual({ status: 'live' });

    const readyRes = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });
    expect(readyRes.statusCode).toBe(200);
    expect(JSON.parse(readyRes.payload)).toEqual({ status: 'ready', database: 'connected' });
  });

  it('Creates a show and initializes seats in available status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/shows',
      payload: {
        name: 'Coldplay Live',
        seats: ['A1', 'A2', 'A3', 'A4', 'A5'],
        price_paise: 500000,
        per_user_limit: 4,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.id).toBeDefined();
    expect(body.total_seats).toBe(5);
    expect(body.price_paise).toBe(500000);
    expect(body.seats.length).toBe(5);
    expect(body.seats.every((s: any) => s.status === 'available')).toBe(true);
  });

  it('Guarantees exactly 1 winner under a 50-user hot seat stampede (0 5xx, 49 409s)', async () => {
    // 1. Create fresh show with hot seat A12
    const showRes = await app.inject({
      method: 'POST',
      url: '/shows',
      payload: {
        name: 'Hot Seat Arena',
        seats: ['A12', 'B1', 'B2'],
        price_paise: 25000,
        per_user_limit: 4,
      },
    });
    const show = JSON.parse(showRes.payload);

    // 2. Fire 50 concurrent requests for seat A12 from 50 distinct users
    const contenders = 50;
    const promises = Array.from({ length: contenders }, (_, i) => {
      const userId = `user_${i + 1}`;
      return app.inject({
        method: 'POST',
        url: `/shows/${show.id}/reserve`,
        headers: {
          authorization: `Bearer ${userId}`,
        },
        payload: {
          seats: ['A12'],
          idempotency_key: `key_hot_${userId}`,
        },
      });
    });

    const results = await Promise.all(promises);

    const statusCounts: Record<number, number> = {};
    for (const r of results) {
      statusCounts[r.statusCode] = (statusCounts[r.statusCode] || 0) + 1;
    }

    // Exactly one 201 winner
    expect(statusCounts[201]).toBe(1);
    // Everyone else gets a clean 409 Conflict
    expect(statusCounts[409]).toBe(contenders - 1);
    // Zero 5xx errors
    expect(statusCounts[500] || 0).toBe(0);

    // Check show state & reconciliation invariant
    const stateRes = await app.inject({
      method: 'GET',
      url: `/shows/${show.id}`,
    });
    const state = JSON.parse(stateRes.payload);
    expect(state.reconciliation.invariant_holds).toBe(true);
    expect(state.available_count).toBe(2);
    expect(state.confirmed_count).toBe(1);
    expect(state.held_count).toBe(0);
    expect(state.total_seats).toBe(3);
  });

  it('Idempotent retry returns original reservation without duplicates', async () => {
    const showRes = await app.inject({
      method: 'POST',
      url: '/shows',
      payload: {
        name: 'Idempotency Hall',
        seats: ['C1', 'C2'],
        price_paise: 15000,
      },
    });
    const show = JSON.parse(showRes.payload);
    const key = `idem_key_${Date.now()}`;

    // First request
    const firstRes = await app.inject({
      method: 'POST',
      url: `/shows/${show.id}/reserve`,
      headers: { authorization: 'Bearer user_bob' },
      payload: { seats: ['C1'], idempotency_key: key },
    });
    expect(firstRes.statusCode).toBe(201);
    const firstBody = JSON.parse(firstRes.payload);

    // Second request: identical key and seats
    const retryRes = await app.inject({
      method: 'POST',
      url: `/shows/${show.id}/reserve`,
      headers: { authorization: 'Bearer user_bob' },
      payload: { seats: ['C1'], idempotency_key: key },
    });
    expect(retryRes.statusCode).toBe(201);
    expect(JSON.parse(retryRes.payload)).toEqual(firstBody);

    // Third request: same key with different seat -> 409 Conflict
    const mismatchRes = await app.inject({
      method: 'POST',
      url: `/shows/${show.id}/reserve`,
      headers: { authorization: 'Bearer user_bob' },
      payload: { seats: ['C2'], idempotency_key: key },
    });
    expect(mismatchRes.statusCode).toBe(409);
    expect(JSON.parse(mismatchRes.payload).error).toBe('idempotency_mismatch');
  });

  it('Enforces per-user limit strictly under concurrent requests', async () => {
    // Show has limit = 4, user fires 10 concurrent requests of 1 seat each
    const seats = Array.from({ length: 15 }, (_, i) => `S${i + 1}`);
    const showRes = await app.inject({
      method: 'POST',
      url: '/shows',
      payload: {
        name: 'Limit Test Hall',
        seats,
        price_paise: 10000,
        per_user_limit: 4,
      },
    });
    const show = JSON.parse(showRes.payload);

    const attempts = 10;
    const promises = Array.from({ length: attempts }, (_, i) => {
      return app.inject({
        method: 'POST',
        url: `/shows/${show.id}/reserve`,
        headers: { authorization: 'Bearer greedy_user' },
        payload: {
          seats: [seats[i]],
          idempotency_key: `limit_key_${i}`,
        },
      });
    });

    const results = await Promise.all(promises);
    const statusCounts: Record<number, number> = {};
    for (const r of results) {
      statusCounts[r.statusCode] = (statusCounts[r.statusCode] || 0) + 1;
    }

    // Exactly 4 succeed (the user's limit)
    expect(statusCounts[201]).toBe(4);
    // The remaining 6 get a clean 409 Conflict
    expect(statusCounts[409]).toBe(6);
    // Zero 5xx errors
    expect(statusCounts[500] || 0).toBe(0);

    // Verify reconciliation invariant holds
    const stateRes = await app.inject({
      method: 'GET',
      url: `/shows/${show.id}`,
    });
    const state = JSON.parse(stateRes.payload);
    expect(state.reconciliation.invariant_holds).toBe(true);
    expect(state.confirmed_count).toBe(4);
  });

  it('Avoids deadlocks in multi-seat reservations with inverted seat orders', async () => {
    const showRes = await app.inject({
      method: 'POST',
      url: '/shows',
      payload: {
        name: 'Deadlock Test Theater',
        seats: ['M1', 'M2'],
        price_paise: 10000,
      },
    });
    const show = JSON.parse(showRes.payload);

    // User 1 asks for [M1, M2] while User 2 asks for [M2, M1] concurrently
    const req1 = app.inject({
      method: 'POST',
      url: `/shows/${show.id}/reserve`,
      headers: { authorization: 'Bearer user_deadlock_1' },
      payload: { seats: ['M1', 'M2'], idempotency_key: 'dl_key_1' },
    });
    const req2 = app.inject({
      method: 'POST',
      url: `/shows/${show.id}/reserve`,
      headers: { authorization: 'Bearer user_deadlock_2' },
      payload: { seats: ['M2', 'M1'], idempotency_key: 'dl_key_2' },
    });

    const [res1, res2] = await Promise.all([req1, req2]);
    const codes = [res1.statusCode, res2.statusCode].sort();
    
    // Exactly one 201 winner, exactly one 409 conflict, no deadlock / 500
    expect(codes).toEqual([201, 409]);
  });

  it('Cancellation releases seats back to available; non-owner gets 403', async () => {
    const showRes = await app.inject({
      method: 'POST',
      url: '/shows',
      payload: {
        name: 'Cancel Test Hall',
        seats: ['X1', 'X2'],
        price_paise: 20000,
      },
    });
    const show = JSON.parse(showRes.payload);

    const reserveRes = await app.inject({
      method: 'POST',
      url: `/shows/${show.id}/reserve`,
      headers: { authorization: 'Bearer owner_user' },
      payload: { seats: ['X1'], idempotency_key: 'cancel_test_key_1' },
    });
    expect(reserveRes.statusCode).toBe(201);
    const reservation = JSON.parse(reserveRes.payload);

    // Non-owner attempts to cancel -> 403 Forbidden
    const imposterRes = await app.inject({
      method: 'POST',
      url: `/reservations/${reservation.reservation_id}/cancel`,
      headers: { authorization: 'Bearer imposter_user' },
    });
    expect(imposterRes.statusCode).toBe(403);

    // Owner cancels -> 200 OK
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/reservations/${reservation.reservation_id}/cancel`,
      headers: { authorization: 'Bearer owner_user' },
    });
    expect(cancelRes.statusCode).toBe(200);

    // Seat X1 must now be available and re-bookable
    const rebookRes = await app.inject({
      method: 'POST',
      url: `/shows/${show.id}/reserve`,
      headers: { authorization: 'Bearer new_user' },
      payload: { seats: ['X1'], idempotency_key: 'rebook_key_1' },
    });
    expect(rebookRes.statusCode).toBe(201);

    // Reconciliation invariant holds
    const stateRes = await app.inject({
      method: 'GET',
      url: `/shows/${show.id}`,
    });
    const state = JSON.parse(stateRes.payload);
    expect(state.reconciliation.invariant_holds).toBe(true);
    expect(state.confirmed_count).toBe(1);
    expect(state.available_count).toBe(1);
  });
});
