# Seat Reservation Service — Technical Architecture & Correctness Write-Up

## 1. The Atomic Decision Mechanism
### Where the Decision Lives
In high-throughput ticketing systems, the greatest vulnerability is the "read-then-write" race condition (e.g. `SELECT status FROM seats WHERE ...` followed by an `UPDATE`). Under a stampede of concurrent buyers, multiple transactions read `available` simultaneously and subsequently execute writes, resulting in catastrophic double-selling.

In this service, **the atomic decision lives entirely inside PostgreSQL 16 at the database row-lock layer within a single transaction**:
```sql
SELECT seat_number, status 
FROM seats 
WHERE show_id = $1 AND seat_number = ANY($2::text[])
ORDER BY seat_number ASC
FOR UPDATE;
```

### Why It Is Strictly Race-Free
1. **Row-Level Mutex (`FOR UPDATE`)**: The first transaction to reach PostgreSQL acquires exclusive row-level locks on the exact seat rows requested.
2. **Deterministic Serialization**: All subsequent concurrent transactions requesting the same seat(s) are blocked by the database engine until the active transaction issues `COMMIT` or `ROLLBACK`.
3. **Guarded State Transition**: Once the lock is acquired, the service validates that `status === 'available'`. If valid, it transitions the seat to `confirmed` and commits. When the waiting transactions acquire their turn, they immediately observe `status = 'confirmed'`. The service identifies this and rolls back without modifying state, returning a clean `409 Conflict` (HTTP 409 `seat_taken`).
4. **All-or-Nothing Multi-Seat Semantics**: If a customer requests `["A1", "A2"]` and only `A1` is free while `A2` is taken, the transaction aborts and issues a full `ROLLBACK`. Neither seat is reserved, returning a domain rejection `409 Conflict` with `unavailable_seats: ["A2"]`.

### Deadlock Elimination for Multi-Seat Requests
If User 1 requests `[A1, A2]` and User 2 requests `[A2, A1]` concurrently, a naïve system locks `A1` first in Tx1 and `A2` first in Tx2. Tx1 then waits for `A2` while Tx2 waits for `A1`, causing a database deadlock (`40P01` deadlock detected).

**Solution**: Before any lock acquisition, the array of requested seats is sorted lexicographically (`ORDER BY seat_number ASC` in SQL and `seats.sort()` in application logic). Because all transactions acquire locks in the exact same physical order (`A1` then `A2`), circular lock dependency graphs are mathematically impossible. Deadlocks are eliminated by construction.

---

## 2. Idempotency Architecture
### Storage & Lifecycle
Idempotency state is persisted in a dedicated PostgreSQL table (`idempotency_keys`):
- `key` (TEXT PRIMARY KEY): Unique identifier supplied by the client via the `idempotency_key` JSON field or `Idempotency-Key` / `X-Idempotency-Key` headers.
- `show_id` (UUID): The target show.
- `user_id` (TEXT): The token-derived caller identity.
- `request_hash` (TEXT): SHA-256 cryptographic digest of the normalized, sorted request parameters (`{ showId, seats }`).
- `status_code` (INT): The original HTTP response code (e.g., 201).
- `response_body` (JSONB): The exact serialized JSON response body.
- `created_at` (TIMESTAMPTZ): Audit timestamp.

### Exactly-Once Enforcement
1. **Pipelined Read Check**: Before acquiring row locks or starting heavy logic, the service executes a quick indexed read on `idempotency_keys(key)`. If an exact match (`request_hash` + `user_id`) is found, it immediately replays the cached 201 payload and increments `idempotent_replays_total`.
2. **In-Flight Lock Protection**: For concurrent duplicate requests fired in parallel, an explicit row-level check (`SELECT ... FROM idempotency_keys WHERE key = $1 FOR UPDATE`) inside the transaction prevents two concurrent workers from inserting or double-booking. The primary key constraint on `key` also guarantees database-level isolation.

### Same Key with Different Body Handling
If a client attempts to reuse an existing idempotency key with different seats or for a different show, the computed SHA-256 hash does not match `stored.request_hash`.
The service immediately rejects the request with HTTP **`409 Conflict`** and domain reason:
```json
{
  "error": "idempotency_mismatch",
  "message": "Idempotency key has already been used with different request parameters"
}
```
This increments the `reservations_declined_total{reason="idempotency_mismatch"}` counter.

---

## 3. Holds & Expiry vs Immediate Confirmation
### Chosen Model: Explicit Cancellation with Token-Verified Ownership
The service implements **immediate atomic reservation (`confirmed`) with explicit cancellation (`POST /reservations/:id/cancel`)**, complemented by token-derived authorization:
- Only the authenticated owner whose `user_id` matches `reservation.user_id` can trigger cancellation. Non-owners are rejected with `403 Forbidden`.
- During cancellation, the reservation row is locked (`FOR UPDATE`). Its status transitions to `cancelled`, and the associated seats are returned to `available` in the same transaction.
- The seat immediately becomes re-bookable by other users.
- A release cannot resurrect or overwrite seats confirmed to someone else because the seat transition is guarded by the unique reservation-seat foreign key binding.

### Time-Boxed Holds (Extension Path)
For a 10-minute cart checkout hold model, seats transition to `held` with an `expires_at` timestamp. Under that model:
1. `FOR UPDATE` queries lock the seat and evaluate:
   ```sql
   status = 'available' OR (status = 'held' AND held_until < NOW())
   ```
2. A lightweight background worker (e.g. pg_cron or node scheduled ticker) lazily sweeps expired holds back to `available` and updates Prometheus metrics.
3. In both models, the reconciliation invariant `available + held + confirmed == total_seats` holds true across every clock tick.

---

## 4. Per-User Limit Enforcement
To prevent a single user from scripting concurrent threads to exceed their allocation (default 4 seats per show):
1. **Advisory Transaction Lock**:
   At the start of the reservation transaction, the service acquires a PostgreSQL transactional advisory lock scoped to the `(show_id, user_id)` pair:
   ```sql
   SELECT pg_advisory_xact_lock(hashtext('show_user:' || $1 || ':' || $2));
   ```
2. **Serializable Counting**:
   While holding the advisory lock, the service counts all currently active confirmed seats for this user:
   ```sql
   SELECT COUNT(rs.seat_number)::int 
   FROM reservation_seats rs
   JOIN reservations r ON rs.reservation_id = r.id
   WHERE r.show_id = $1 AND r.user_id = $2 AND r.status = 'confirmed';
   ```
3. If `active_count + requested.length > per_user_limit`, the transaction aborts with `ROLLBACK` and returns HTTP `409 Conflict` (`per_user_limit_exceeded`).
4. Because concurrent requests from the same user are serialized on the advisory lock, no race condition can ever allow a user to hold 5 seats on a limit=4 show.

---

## 5. Consistency vs Availability Under Network Partitions (CAP Theorem)
In ticketing for physical numbered seats, **consistency and partition tolerance (CP) are paramount over availability (AP)**.
- If an AP system (eventual consistency) is used across multiple datacenters during an on-sale stampede, split-brain network partitions will inevitably sell Seat A12 to Alice in Mumbai and Bob in Singapore simultaneously.
- Physical seats cannot be merged or conflict-resolved after two humans arrive at the theater with tickets for Row A, Seat 12.
- Therefore, our architecture chooses **Strict Consistency**:
  - PostgreSQL acts as the single authoritative System of Record.
  - Transactions require strict quorum/linearizability.
  - In the event of a network partition between replicas and primary, write requests fail closed with a clean client error (or retry loop) rather than creating double-allocated tickets.

---

## 6. Observability: What We Page For at 2:00 AM
Observability is built directly into the core engine via Prometheus (`prom-client`) and structured Pino logging:

### High-Severity Paging Alerts (PagerDuty / OpsGenie)
1. **Reconciliation Invariant Breach (P0 - Immediate Wakeup)**:
   - Condition: `seats_available + seats_held + seats_confirmed != total_seats`
   - Signifies database corruption, orphaned records, or a leaked transaction.
2. **Elevated 5xx Error Rate (`http_requests_total{status_code=~"5.."}` > 0.1% over 1m)**:
   - System design mandates that seat contention, limit exceedance, and duplicate keys produce 4xx domain outcomes. Any 5xx represents an unhandled bug, pool exhaustion, or database crash.
3. **Database Readiness Failure (`/health/ready` returning 503)**:
   - Signals that the PostgreSQL connection pool is saturated, network connectivity to the DB is broken, or the primary database crashed.
4. **Connection Pool Starvation (`db_pool_waiting_clients` > 10 for > 30s)**:
   - Signals slow transactions or locking bottlenecks holding pool connections too long.

### Dashboard Monitoring (Grafana / Prometheus)
- `reservations_confirmed_total{show_id}`: Real-time velocity of sold tickets.
- `reservations_declined_total{reason}`: Breakdown of customer rejections (`seat_taken`, `per_user_limit`, `idempotency_mismatch`).
- `idempotent_replays_total`: Rate of duplicate network retries cleanly absorbed without re-processing.
- `http_request_duration_seconds`: p50, p95, and p99 latency distributions.

---

## 7. AI Usage Disclosure (Directed vs Decided)
Per the assignment guidelines, here is a transparent and honest breakdown of AI assistance vs human engineering judgment:

### What Was Directed (Human Decisions)
- **The Core Invariant Model**: Deciding to push concurrency control into PostgreSQL row locks (`FOR UPDATE`) with lexicographical seat sorting rather than trusting distributed Redis locks (which suffer from TTL expiry during GC pauses and split-brain risks).
- **Advisory Locks for Per-User Limits**: Deciding to use `pg_advisory_xact_lock(hashtext(...))` to serialize reservations per `(show, user)` so that concurrent limit checks cannot race.
- **Idempotency Strategy**: Defining the SHA-256 payload hashing scheme to differentiate valid idempotent retries from malicious or buggy key reuses.
- **Testing Architecture**: Designing the 9-phase burst benchmark simulating 500+ concurrent hot-seat contenders, inverted deadlock pairs, and reconciliation audits.

### What Was Decided / Accelerated by AI
- **Boilerplate & Schema Generation**: Rapidly generating initial TypeScript types, Fastify route schemas, and Prometheus registry definitions.
- **Test Scaffolding**: Auto-completing Vitest inject assertions and concurrent Promise array generators.
- **Formatting & Scripting**: Polishing the terminal output formatting in `scripts/burst.js` and Dockerfile layer caching directives.

---

## 8. What We Would Do Next (Production Roadmap)
If scaling this system to millions of concurrent users across multiple shows:
1. **Read-Through Seat Maps in Redis**: Cache seat availability bitmaps in Redis with sub-millisecond read latency for `GET /shows/{id}` seat maps, invalidating or updating via PostgreSQL CDC (Debezium / pg_logical replication).
2. **Virtual Waiting Room (Queuing Layer)**: Front the API with Cloudflare Waiting Room or AWS SQS + Redis token buckets at $t=0$ to shape traffic from 100,000 incoming requests/sec into a steady stream of 2,000 req/s that matches the database's write throughput capacity.
3. **Partitioning / Sharding**: Shard the `seats` and `reservations` tables by `show_id` hash across distinct database nodes, enabling horizontal scale where separate concert sales never compete for database locks.
4. **OpenTelemetry Distributed Tracing**: Export traces to Jaeger / Honeycomb with span tags for database lock wait times, pinpointing contention bottlenecks under load.
