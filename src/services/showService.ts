import { pool } from '../db.js';
import { logger } from '../logger.js';
import { seatsAvailableGauge } from '../metrics.js';

export interface CreateShowInput {
  name: string;
  seats: string[];
  price_paise: number;
  per_user_limit?: number;
}

export interface ShowSeatState {
  seat_number: string;
  status: 'available' | 'held' | 'confirmed';
}

export interface ShowStateResponse {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  total_seats: number;
  available_count: number;
  held_count: number;
  confirmed_count: number;
  reconciliation: {
    invariant_holds: boolean;
    sum: number;
    total: number;
  };
  seats: ShowSeatState[];
}

export async function createShow(input: CreateShowInput) {
  const { name, seats, price_paise, per_user_limit = 4 } = input;

  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new Error('Show name is required');
  }

  if (!Array.isArray(seats) || seats.length === 0) {
    throw new Error('Seats must be a non-empty array');
  }

  // Deduplicate seats
  const uniqueSeats = Array.from(new Set(seats.map(s => String(s).trim()))).filter(Boolean);
  if (uniqueSeats.length === 0) {
    throw new Error('Valid seat numbers required');
  }

  if (!Number.isInteger(price_paise) || price_paise < 0) {
    throw new Error('price_paise must be a non-negative integer');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const showRes = await client.query(
      `INSERT INTO shows (name, price_paise, per_user_limit, total_seats)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, price_paise, per_user_limit, total_seats, created_at`,
      [name.trim(), price_paise, per_user_limit, uniqueSeats.length]
    );
    const show = showRes.rows[0];

    // Batch insert seats
    // Unnesting two arrays or multiple values
    const query = `
      INSERT INTO seats (show_id, seat_number, status, version)
      SELECT $1, unnest($2::text[]), 'available', 1
    `;
    await client.query(query, [show.id, uniqueSeats]);

    await client.query('COMMIT');

    seatsAvailableGauge.set({ show_id: show.id }, uniqueSeats.length);

    logger.info({ showId: show.id, totalSeats: uniqueSeats.length }, 'Show created successfully');

    return {
      ...show,
      price_paise: Number(show.price_paise),
      seats: uniqueSeats.map(seat => ({ seat_number: seat, status: 'available' })),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'Failed to create show');
    throw err;
  } finally {
    client.release();
  }
}

export async function getShowState(showId: string): Promise<ShowStateResponse | null> {
  const showRes = await pool.query(
    `SELECT id, name, price_paise, per_user_limit, total_seats 
     FROM shows WHERE id = $1`,
    [showId]
  );

  if (showRes.rows.length === 0) {
    return null;
  }

  const show = showRes.rows[0];

  const seatsRes = await pool.query(
    `SELECT seat_number, status 
     FROM seats 
     WHERE show_id = $1 
     ORDER BY seat_number ASC`,
    [showId]
  );

  let available_count = 0;
  let held_count = 0;
  let confirmed_count = 0;

  for (const row of seatsRes.rows) {
    if (row.status === 'available') available_count++;
    else if (row.status === 'held') held_count++;
    else if (row.status === 'confirmed') confirmed_count++;
  }

  const total = Number(show.total_seats);
  const sum = available_count + held_count + confirmed_count;
  const invariant_holds = sum === total;

  if (!invariant_holds) {
    logger.error(
      { showId, sum, total, available_count, held_count, confirmed_count },
      'CRITICAL INVARIANT VIOLATION: available + held + confirmed != total_seats'
    );
  }

  // Update Prometheus gauge for available seats
  seatsAvailableGauge.set({ show_id: showId }, available_count);

  return {
    id: show.id,
    name: show.name,
    price_paise: Number(show.price_paise),
    per_user_limit: show.per_user_limit,
    total_seats: total,
    available_count,
    held_count,
    confirmed_count,
    reconciliation: {
      invariant_holds,
      sum,
      total,
    },
    seats: seatsRes.rows,
  };
}
