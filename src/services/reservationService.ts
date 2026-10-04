import crypto from 'crypto';
import { pool } from '../db.js';
import { logger } from '../logger.js';
import {
  reservationsConfirmedTotal,
  reservationsDeclinedTotal,
  idempotentReplaysTotal,
  reservationsCancelledTotal,
  seatsAvailableGauge,
} from '../metrics.js';
import { isValidUuid } from '../utils.js';

export interface ReserveSeatInput {
  showId: string;
  userId: string;
  seats: string[];
  idempotencyKey: string;
}

export interface ReservationResult {
  statusCode: number;
  body: any;
}

export function computeRequestHash(showId: string, seats: string[]): string {
  const sortedSeats = [...seats].sort();
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ showId, seats: sortedSeats }))
    .digest('hex');
}

export async function reserveSeats(input: ReserveSeatInput): Promise<ReservationResult> {
  const { showId, userId, seats, idempotencyKey } = input;

  if (!isValidUuid(showId)) {
    return {
      statusCode: 404,
      body: { error: 'not_found', message: 'Show not found' },
    };
  }

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    reservationsDeclinedTotal.inc({ reason: 'missing_idempotency_key', show_id: showId });
    return {
      statusCode: 400,
      body: { error: 'bad_request', message: 'idempotency_key is required' },
    };
  }

  if (!Array.isArray(seats) || seats.length === 0) {
    reservationsDeclinedTotal.inc({ reason: 'invalid_seats', show_id: showId });
    return {
      statusCode: 400,
      body: { error: 'bad_request', message: 'seats must be a non-empty array' },
    };
  }

  // Deduplicate and trim requested seats
  const requestedSeats = Array.from(new Set(seats.map(s => String(s).trim()))).filter(Boolean);
  if (requestedSeats.length === 0) {
    reservationsDeclinedTotal.inc({ reason: 'invalid_seats', show_id: showId });
    return {
      statusCode: 400,
      body: { error: 'bad_request', message: 'No valid seats provided' },
    };
  }

  // Sort seats lexicographically to guarantee deadlock-free locking
  requestedSeats.sort();

  const requestHash = computeRequestHash(showId, requestedSeats);

  // 1. Fast check for existing idempotency key before opening transaction
  const existingIdempotency = await pool.query(
    `SELECT key, show_id, user_id, request_hash, status_code, response_body 
     FROM idempotency_keys WHERE key = $1`,
    [idempotencyKey.trim()]
  );

  if (existingIdempotency.rows.length > 0) {
    const existing = existingIdempotency.rows[0];
    if (existing.request_hash === requestHash && existing.user_id === userId) {
      // Identical retry -> replay exact response
      idempotentReplaysTotal.inc({ show_id: showId });
      logger.info({ idempotencyKey, userId, showId }, 'Idempotent replay served');
      return {
        statusCode: existing.status_code,
        body: existing.response_body,
      };
    } else {
      // Same key with different payload/seats or different user -> 409 Conflict
      reservationsDeclinedTotal.inc({ reason: 'idempotency_mismatch', show_id: showId });
      logger.warn({ idempotencyKey, userId, showId }, 'Idempotency key reused with mismatched body');
      return {
        statusCode: 409,
        body: {
          error: 'idempotency_mismatch',
          message: 'Idempotency key has already been used with different request parameters',
        },
      };
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 2. Double-check idempotency key inside transaction with row lock to handle race conditions
    const txIdempotency = await client.query(
      `SELECT key, show_id, user_id, request_hash, status_code, response_body 
       FROM idempotency_keys WHERE key = $1 FOR UPDATE`,
      [idempotencyKey.trim()]
    );

    if (txIdempotency.rows.length > 0) {
      await client.query('ROLLBACK');
      const existing = txIdempotency.rows[0];
      if (existing.request_hash === requestHash && existing.user_id === userId) {
        idempotentReplaysTotal.inc({ show_id: showId });
        return {
          statusCode: existing.status_code,
          body: existing.response_body,
        };
      } else {
        reservationsDeclinedTotal.inc({ reason: 'idempotency_mismatch', show_id: showId });
        return {
          statusCode: 409,
          body: {
            error: 'idempotency_mismatch',
            message: 'Idempotency key has already been used with different request parameters',
          },
        };
      }
    }

    // 3. Acquire transaction-level advisory lock per (show, user) to prevent concurrent limit bypass
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('show_user:' || $1 || ':' || $2))`,
      [showId, userId]
    );

    // 4. Fetch show details
    const showRes = await client.query(
      `SELECT id, price_paise, per_user_limit FROM shows WHERE id = $1`,
      [showId]
    );

    if (showRes.rows.length === 0) {
      await client.query('ROLLBACK');
      reservationsDeclinedTotal.inc({ reason: 'show_not_found', show_id: showId });
      return {
        statusCode: 404,
        body: { error: 'not_found', message: 'Show not found' },
      };
    }

    const show = showRes.rows[0];
    const perUserLimit = Number(show.per_user_limit);
    const pricePaise = Number(show.price_paise);

    // 5. Check per-user limit under concurrency
    const userSeatsRes = await client.query(
      `SELECT COUNT(rs.seat_number)::int AS count 
       FROM reservation_seats rs
       JOIN reservations r ON rs.reservation_id = r.id
       WHERE r.show_id = $1 AND r.user_id = $2 AND r.status = 'confirmed'`,
      [showId, userId]
    );

    const currentlyHeld = Number(userSeatsRes.rows[0]?.count || 0);
    if (currentlyHeld + requestedSeats.length > perUserLimit) {
      await client.query('ROLLBACK');
      reservationsDeclinedTotal.inc({ reason: 'per_user_limit', show_id: showId });
      logger.info(
        { userId, showId, currentlyHeld, requested: requestedSeats.length, perUserLimit },
        'Reservation declined: per-user limit exceeded'
      );
      return {
        statusCode: 409,
        body: {
          error: 'per_user_limit_exceeded',
          message: `Booking exceeds maximum limit of ${perUserLimit} seats per user for this show`,
          currently_held: currentlyHeld,
          requested: requestedSeats.length,
          limit: perUserLimit,
        },
      };
    }

    // 6. Lock seat rows in strict deterministic order (deadlock prevention)
    const seatsRes = await client.query(
      `SELECT seat_number, status 
       FROM seats 
       WHERE show_id = $1 AND seat_number = ANY($2::text[])
       ORDER BY seat_number ASC
       FOR UPDATE`,
      [showId, requestedSeats]
    );

    // Verify all requested seats exist for this show
    if (seatsRes.rows.length !== requestedSeats.length) {
      await client.query('ROLLBACK');
      const foundSeats = new Set(seatsRes.rows.map(r => r.seat_number));
      const missingSeats = requestedSeats.filter(s => !foundSeats.has(s));
      reservationsDeclinedTotal.inc({ reason: 'invalid_seats', show_id: showId });
      return {
        statusCode: 409,
        body: {
          error: 'invalid_seats',
          message: 'One or more requested seats do not exist in this show',
          missing_seats: missingSeats,
        },
      };
    }

    // Check availability (All-or-Nothing model)
    const unavailableSeats = seatsRes.rows
      .filter(r => r.status !== 'available')
      .map(r => r.seat_number);

    if (unavailableSeats.length > 0) {
      await client.query('ROLLBACK');
      reservationsDeclinedTotal.inc({ reason: 'seat_taken', show_id: showId });
      logger.info({ showId, userId, unavailableSeats }, 'Reservation declined: seat already taken');
      return {
        statusCode: 409,
        body: {
          error: 'seat_taken',
          message: 'One or more requested seats are already taken',
          unavailable_seats: unavailableSeats,
        },
      };
    }

    // 7. Atomic update: transition seats from 'available' to 'confirmed'
    await client.query(
      `UPDATE seats 
       SET status = 'confirmed', updated_at = NOW() 
       WHERE show_id = $1 AND seat_number = ANY($2::text[])`,
      [showId, requestedSeats]
    );

    const totalAmountPaise = pricePaise * requestedSeats.length;

    // 8. Create reservation record
    const resInsert = await client.query(
      `INSERT INTO reservations (show_id, user_id, status, amount_paise)
       VALUES ($1, $2, 'confirmed', $3)
       RETURNING id, show_id, user_id, status, amount_paise, created_at`,
      [showId, userId, totalAmountPaise]
    );
    const reservation = resInsert.rows[0];

    // 9. Map seats to reservation
    await client.query(
      `INSERT INTO reservation_seats (reservation_id, show_id, seat_number)
       SELECT $1, $2, unnest($3::text[])`,
      [reservation.id, showId, requestedSeats]
    );

    const responseBody = {
      reservation_id: reservation.id,
      show_id: reservation.show_id,
      user_id: reservation.user_id,
      seats: requestedSeats,
      amount_paise: Number(reservation.amount_paise),
      status: reservation.status,
    };

    // 10. Record idempotency key mapping
    await client.query(
      `INSERT INTO idempotency_keys (key, show_id, user_id, request_hash, status_code, response_body)
       VALUES ($1, $2, $3, $4, 201, $5)`,
      [idempotencyKey.trim(), showId, userId, requestHash, responseBody]
    );

    await client.query('COMMIT');

    reservationsConfirmedTotal.inc({ show_id: showId });
    logger.info(
      { reservationId: reservation.id, showId, userId, seats: requestedSeats },
      'Reservation confirmed successfully'
    );

    return {
      statusCode: 201,
      body: responseBody,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err, showId, userId }, 'Unexpected error during seat reservation');
    throw err;
  } finally {
    client.release();
  }
}

export async function cancelReservation(reservationId: string, userId: string): Promise<ReservationResult> {
  if (!isValidUuid(reservationId)) {
    return {
      statusCode: 404,
      body: { error: 'not_found', message: 'Reservation not found' },
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock the reservation row
    const resResult = await client.query(
      `SELECT id, show_id, user_id, status, amount_paise 
       FROM reservations 
       WHERE id = $1 
       FOR UPDATE`,
      [reservationId]
    );

    if (resResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return {
        statusCode: 404,
        body: { error: 'not_found', message: 'Reservation not found' },
      };
    }

    const reservation = resResult.rows[0];

    // 2. Strict identity verification: only the owner may cancel
    if (reservation.user_id !== userId) {
      await client.query('ROLLBACK');
      logger.warn(
        { reservationId, ownerId: reservation.user_id, attemptUserId: userId },
        'Unauthorized cancellation attempt'
      );
      return {
        statusCode: 403,
        body: {
          error: 'forbidden',
          message: 'You are not authorized to cancel this reservation',
        },
      };
    }

    if (reservation.status === 'cancelled') {
      await client.query('ROLLBACK');
      return {
        statusCode: 409,
        body: { error: 'conflict', message: 'Reservation has already been cancelled' },
      };
    }

    // 3. Retrieve seats associated with this reservation
    const seatsRes = await client.query(
      `SELECT seat_number FROM reservation_seats WHERE reservation_id = $1`,
      [reservationId]
    );
    const seatsToRelease = seatsRes.rows.map(r => r.seat_number);

    // 4. Update reservation status
    await client.query(
      `UPDATE reservations 
       SET status = 'cancelled', updated_at = NOW() 
       WHERE id = $1`,
      [reservationId]
    );

    // 5. Release seats back to available atomically
    await client.query(
      `UPDATE seats 
       SET status = 'available', updated_at = NOW() 
       WHERE show_id = $1 AND seat_number = ANY($2::text[])`,
      [reservation.show_id, seatsToRelease]
    );

    await client.query('COMMIT');

    reservationsCancelledTotal.inc({ show_id: reservation.show_id });
    logger.info(
      { reservationId, showId: reservation.show_id, seatsReleased: seatsToRelease },
      'Reservation cancelled and seats released'
    );

    return {
      statusCode: 200,
      body: {
        message: 'Reservation cancelled successfully',
        reservation_id: reservationId,
        show_id: reservation.show_id,
        seats_released: seatsToRelease,
        status: 'cancelled',
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err, reservationId, userId }, 'Error cancelling reservation');
    throw err;
  } finally {
    client.release();
  }
}
