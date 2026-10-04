# High-Scale Seat Reservation Service

A production-grade, highly concurrent seat reservation service designed for high-demand on-sale events (concerts, movies, sporting events).

Built with **Node.js, TypeScript, Fastify, and PostgreSQL 16**.

---

## 🎯 Key Guarantees Under Load
- **Zero Double-Selling**: Guaranteed at the database row-locking layer (`SELECT ... FOR UPDATE`).
- **Deadlock-Free Multi-Seat Bookings**: Lexicographically sorted seat acquisition prevents circular lock dependencies.
- **Strict Invariant Guarantee**: `available + held + confirmed == total_seats` holds to the exact unit at all times.
- **Idempotency with Body Verification**: Identical retries return cached responses; same-key-different-body is rejected with `409 Conflict`.
- **Per-User Booking Limits**: Transaction-scoped advisory locks prevent race conditions when users attempt concurrent bookings over their limit.
- **Token-Derived Identity**: Strict authorization prevents caller spoofing; only reservation owners can cancel their bookings.
- **Zero 5xx Under Load**: Contention and domain declines are handled gracefully as 4xx status codes (`409 Conflict`), never internal server errors.
- **Full Observability**: Prometheus metrics (`/metrics`) and structured Pino JSON logs with correlation IDs (`x-request-id`).

---

## 🚀 Quickstart

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) & Docker Compose
- Node.js 22+ (optional, for local development without Docker)

### 1. Launch with Docker Compose
```bash
docker compose up --build -d
```
This spins up:
- **App Service**: Listening on `http://localhost:3000`
- **PostgreSQL 16**: Healthy check enabled on port `5432` with auto-applied migrations

Verify health:
```bash
curl http://localhost:3000/health/ready
# {"status":"ready","database":"connected"}
```

---

## 💥 Running the On-Sale Concurrency Burst

Run the automated one-command burst simulation script against the service:

```bash
# Against local Docker container
./burst.sh http://localhost:3000

# Or via Makefile
make burst
```

### What the Burst Simulates:
1. **Health Verification**: Asserts `/health/live` and `/health/ready` are operational.
2. **Show Creation**: Provisions a fresh show with 50 seats.
3. **Hot Seat Storm**: **500 concurrent buyers** simultaneously compete for the exact same seat (`A1`). Exactly one 201 winner; 499 receive clean 409s; **zero 500 errors**.
4. **Idempotency Storm**: **100 concurrent requests** fire the identical idempotency key in parallel, verifying that only 1 reservation is processed and 99 return exact replayed results.
5. **Idempotency Mismatch Detection**: Reuses the idempotency key with different seat parameters; verifies rejection with `409 Conflict` (`idempotency_mismatch`).
6. **Deadlock Prevention Storm**: Pairs of concurrent requests attempt conflicting inverted multi-seat bookings (`[A3, A4]` vs `[A4, A3]`), verifying deadlock-free resolution.
7. **Per-User Limit Storm**: A single user fires 10 concurrent requests for distinct seats on a `limit=4` show; verifies exactly 4 succeed and 6 are declined.
8. **Cancellation & Re-Booking**: Verifies token-enforced authorization (non-owners receive 403 Forbidden; owner receives 200 OK and seat is returned to available and re-booked).
9. **Mathematical Invariant Audit**: Queries final state and Prometheus metrics, verifying `available + held + confirmed == total_seats` to the exact single unit.

---

## 🧪 Running Automated Tests

Run the complete Vitest integration and concurrency suite:

```bash
npm test
```

---

## 📡 API Specification

### 1. Create a Show (Admin)
`POST /shows`

**Request Body:**
```json
{
  "name": "Friday Night Live",
  "seats": ["A1", "A2", "A3", "A4", "B1", "B2"],
  "price_paise": 25000,
  "per_user_limit": 4
}
```

**Response (201 Created):**
```json
{
  "id": "e93f9c64-42f2-4bc4-9d51-40ef36b899a1",
  "name": "Friday Night Live",
  "price_paise": 25000,
  "per_user_limit": 4,
  "total_seats": 6,
  "seats": [
    { "seat_number": "A1", "status": "available" },
    { "seat_number": "A2", "status": "available" }
  ]
}
```

---

### 2. Reserve Seat(s) (Authenticated User)
`POST /shows/:id/reserve`

**Headers:**
- `Authorization: Bearer <user_token>` (e.g. `Bearer user_alice` or JWT)
- `Idempotency-Key: <unique_key>` (or inside JSON body)

**Request Body:**
```json
{
  "seats": ["A1", "A2"],
  "idempotency_key": "order_req_9981"
}
```

**Response (201 Created):**
```json
{
  "reservation_id": "76458656-af74-4740-abb4-acdbbaa71b31",
  "show_id": "e93f9c64-42f2-4bc4-9d51-40ef36b899a1",
  "user_id": "user_alice",
  "seats": ["A1", "A2"],
  "amount_paise": 50000,
  "status": "confirmed"
}
```

**Conflict Outcomes (409 Conflict):**
- **Seat taken**:
  ```json
  { "error": "seat_taken", "message": "One or more requested seats are already taken", "unavailable_seats": ["A1"] }
  ```
- **Per-user limit exceeded**:
  ```json
  { "error": "per_user_limit_exceeded", "message": "Booking exceeds maximum limit of 4 seats per user for this show", "currently_held": 3, "requested": 2, "limit": 4 }
  ```
- **Idempotency mismatch**:
  ```json
  { "error": "idempotency_mismatch", "message": "Idempotency key has already been used with different request parameters" }
  ```

---

### 3. Cancel Reservation (Authenticated Owner)
`POST /reservations/:id/cancel`

**Headers:**
- `Authorization: Bearer <user_token>` (must match reservation owner)

**Response (200 OK):**
```json
{
  "message": "Reservation cancelled successfully",
  "reservation_id": "76458656-af74-4740-abb4-acdbbaa71b31",
  "show_id": "e93f9c64-42f2-4bc4-9d51-40ef36b899a1",
  "seats_released": ["A1", "A2"],
  "status": "cancelled"
}
```
*(Unauthorized callers receive `403 Forbidden`)*

---

### 4. Show State & Reconciliation
`GET /shows/:id`

**Response (200 OK):**
```json
{
  "id": "e93f9c64-42f2-4bc4-9d51-40ef36b899a1",
  "name": "Friday Night Live",
  "price_paise": 25000,
  "per_user_limit": 4,
  "total_seats": 6,
  "available_count": 4,
  "held_count": 0,
  "confirmed_count": 2,
  "reconciliation": {
    "invariant_holds": true,
    "sum": 6,
    "total": 6
  },
  "seats": [
    { "seat_number": "A1", "status": "confirmed" },
    { "seat_number": "A2", "status": "confirmed" },
    { "seat_number": "A3", "status": "available" },
    { "seat_number": "A4", "status": "available" },
    { "seat_number": "B1", "status": "available" },
    { "seat_number": "B2", "status": "available" }
  ]
}
```

---

### 5. Health & Observability Endpoints
- **Liveness**: `GET /health/live` (returns 200 if server process is alive)
- **Readiness**: `GET /health/ready` (actively pings database pool; returns 503 if unreachable)
- **Prometheus Metrics**: `GET /metrics`
  - `reservations_confirmed_total{show_id}`
  - `reservations_declined_total{reason, show_id}` (`seat_taken`, `per_user_limit`, `idempotency_mismatch`)
  - `idempotent_replays_total{show_id}`
  - `seats_available{show_id}`
  - `http_requests_total{method, route, status_code}`
  - `http_request_duration_seconds{method, route, status_code}`

---

## 🚢 Cloud Deployment (Render / Railway / Fly.io)

### Environment Variables
| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://postgres:postgres@localhost:5432/seat_reservation` |
| `LOG_LEVEL` | Pino log level (`info`, `debug`, `warn`) | `info` |
| `DEFAULT_PER_USER_LIMIT` | Global fallback seat limit per user | `4` |
| `DB_POOL_MAX` | Maximum database client connections | `50` |

### Deploy on Render / Railway
1. Push repository to GitHub.
2. In Render / Railway, create a new **PostgreSQL Database**.
3. Create a **Web Service** connecting to the repository (using the `Dockerfile`).
4. Set the environment variable:
   `DATABASE_URL=<your-postgres-connection-string>`
5. The container runs migrations automatically upon boot.

---

## 📖 Technical Architecture Write-Up
For in-depth explanations on the atomic decision engine, deadlock prevention, idempotency design, CAP theorem trade-offs, and operational runbooks, see **[WRITEUP.md](WRITEUP.md)**.
