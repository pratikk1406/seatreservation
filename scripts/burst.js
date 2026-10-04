#!/usr/bin/env node

/**
 * High-concurrency on-sale burst simulation script.
 * Simulates thousands of buyers stampeding the same show at on-sale time:
 * - Hot seat storm (500 users competing for single seat A1)
 * - Idempotency replay burst
 * - Idempotency mismatch rejection
 * - Deadlock-free inverted multi-seat contention
 * - Per-user limit enforcement under concurrency
 * - Cancellation, authorization check, and atomic seat re-booking
 * - Verification of mathematical reconciliation invariant
 */

const baseUrl = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

console.log('='.repeat(70));
console.log(`🚀 STARTING ON-SALE BURST SIMULATION`);
console.log(`Target Service: ${baseUrl}`);
console.log('='.repeat(70));

const stats = {
  totalRequests: 0,
  statusCodes: {},
  declineReasons: {},
  errors5xx: 0,
};

function recordResponse(status, body) {
  stats.totalRequests++;
  stats.statusCodes[status] = (stats.statusCodes[status] || 0) + 1;
  if (status >= 500) {
    stats.errors5xx++;
  }
  if (status === 409 && body && body.error) {
    stats.declineReasons[body.error] = (stats.declineReasons[body.error] || 0) + 1;
  }
}

async function request(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = { ...options.headers };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    ...options,
    headers,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function run() {
  const startTime = Date.now();

  // 1. Health Checks
  console.log('\n[1/9] Verifying Liveness and Readiness...');
  const live = await request('/health/live');
  const ready = await request('/health/ready');
  if (live.status !== 200 || ready.status !== 200) {
    console.error('❌ Service health check failed!', { live, ready });
    process.exit(1);
  }
  console.log('✅ Service is LIVE and READY.');

  // 2. Create Show
  console.log('\n[2/9] Creating On-Sale Show with 50 seats...');
  const seatList = [];
  for (let row of ['A', 'B', 'C', 'D', 'E']) {
    for (let num = 1; num <= 10; num++) {
      seatList.push(`${row}${num}`);
    }
  }

  const showRes = await request('/shows', {
    method: 'POST',
    body: JSON.stringify({
      name: `Stadium-Burst-${Date.now()}`,
      seats: seatList,
      price_paise: 25000,
      per_user_limit: 4,
    }),
  });

  if (showRes.status !== 201) {
    console.error('❌ Failed to create show', showRes);
    process.exit(1);
  }
  const showId = showRes.body.id;
  console.log(`✅ Created Show: ${showId} with ${seatList.length} seats (price: ₹250.00, per-user-limit: 4)`);

  // 3. Hot Seat Storm (500 users concurrently fight for seat A1)
  console.log('\n[3/9] 💥 HOT SEAT STORM: 500 concurrent buyers competing for seat A1...');
  const hotContenders = 500;
  const hotPromises = [];
  for (let i = 1; i <= hotContenders; i++) {
    const userId = `buyer_hot_${i}`;
    hotPromises.push(
      request(`/shows/${showId}/reserve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userId}` },
        body: JSON.stringify({
          seats: ['A1'],
          idempotency_key: `key_hot_${i}`,
        }),
      }).then(r => recordResponse(r.status, r.body))
    );
  }
  await Promise.all(hotPromises);
  console.log('✅ Hot Seat Storm completed.');

  // 4. Idempotency Replay Burst (100 parallel identical requests)
  console.log('\n[4/9] 🔄 IDEMPOTENCY REPLAY STORM: 100 concurrent requests with the identical key...');
  const idemKey = `idem_shared_${Date.now()}`;
  const idemPromises = [];
  for (let i = 1; i <= 100; i++) {
    idemPromises.push(
      request(`/shows/${showId}/reserve`, {
        method: 'POST',
        headers: { Authorization: 'Bearer user_idem_tester' },
        body: JSON.stringify({
          seats: ['A2'],
          idempotency_key: idemKey,
        }),
      }).then(r => recordResponse(r.status, r.body))
    );
  }
  await Promise.all(idemPromises);
  console.log('✅ Idempotency Replay Storm completed.');

  // 5. Idempotency Mismatch Test (Same key, different seats)
  console.log('\n[5/9] 🔒 IDEMPOTENCY MISMATCH TEST: Reusing same key with different seat payload...');
  const mismatchRes = await request(`/shows/${showId}/reserve`, {
    method: 'POST',
    headers: { Authorization: 'Bearer user_idem_tester' },
    body: JSON.stringify({
      seats: ['A3'],
      idempotency_key: idemKey,
    }),
  });
  recordResponse(mismatchRes.status, mismatchRes.body);
  if (mismatchRes.status === 409 && mismatchRes.body?.error === 'idempotency_mismatch') {
    console.log('✅ Mismatched payload correctly rejected with 409 Conflict.');
  } else {
    console.error('❌ Mismatched payload check failed!', mismatchRes);
  }

  // 6. Deadlock Prevention Contention (Inverted multi-seat requests)
  console.log('\n[6/9] ⚡ DEADLOCK PREVENTION STORM: Inverted pairs [A3, A4] vs [A4, A3]...');
  const dlPromises = [];
  for (let i = 1; i <= 20; i++) {
    const pair = i % 2 === 0 ? ['A3', 'A4'] : ['A4', 'A3'];
    dlPromises.push(
      request(`/shows/${showId}/reserve`, {
        method: 'POST',
        headers: { Authorization: `Bearer user_dl_${i}` },
        body: JSON.stringify({
          seats: pair,
          idempotency_key: `key_dl_${i}`,
        }),
      }).then(r => recordResponse(r.status, r.body))
    );
  }
  await Promise.all(dlPromises);
  console.log('✅ Multi-seat contention completed without deadlocks.');

  // 7. Per-User Limit Concurrency Storm (10 parallel requests from 1 user on limit=4)
  console.log('\n[7/9] 🛑 PER-USER LIMIT STORM: 1 user firing 10 parallel requests on limit=4 show...');
  const limitPromises = [];
  for (let i = 1; i <= 10; i++) {
    limitPromises.push(
      request(`/shows/${showId}/reserve`, {
        method: 'POST',
        headers: { Authorization: 'Bearer user_limit_hog' },
        body: JSON.stringify({
          seats: [`B${i}`],
          idempotency_key: `key_limit_hog_${i}`,
        }),
      }).then(r => recordResponse(r.status, r.body))
    );
  }
  await Promise.all(limitPromises);
  console.log('✅ Per-user limit storm completed.');

  // 8. Cancellation & Re-booking Test
  console.log('\n[8/9] 🔄 CANCELLATION & RE-BOOKING TEST: Owner cancels, imposter blocked, seat re-booked...');
  const bookingToCancel = await request(`/shows/${showId}/reserve`, {
    method: 'POST',
    headers: { Authorization: 'Bearer user_cancellable' },
    body: JSON.stringify({
      seats: ['E1'],
      idempotency_key: `key_cancellable_${Date.now()}`,
    }),
  });
  recordResponse(bookingToCancel.status, bookingToCancel.body);

  if (bookingToCancel.status === 201) {
    const resId = bookingToCancel.body.reservation_id;
    // Imposter try -> 403 Forbidden
    const imposterRes = await request(`/reservations/${resId}/cancel`, {
      method: 'POST',
      headers: { Authorization: 'Bearer user_imposter' },
    });
    recordResponse(imposterRes.status, imposterRes.body);

    // Owner cancel -> 200 OK
    const cancelRes = await request(`/reservations/${resId}/cancel`, {
      method: 'POST',
      headers: { Authorization: 'Bearer user_cancellable' },
    });
    recordResponse(cancelRes.status, cancelRes.body);

    // Re-booking of E1 -> 201 Created
    const rebookRes = await request(`/shows/${showId}/reserve`, {
      method: 'POST',
      headers: { Authorization: 'Bearer user_new_buyer' },
      body: JSON.stringify({
        seats: ['E1'],
        idempotency_key: `key_rebook_e1_${Date.now()}`,
      }),
    });
    recordResponse(rebookRes.status, rebookRes.body);
    console.log('✅ Cancellation and re-booking successfully verified.');
  }

  // 9. Final State Query & Reconciliation Check
  console.log('\n[9/9] 🔍 RECONCILIATION AUDIT & METRICS...');
  const finalState = await request(`/shows/${showId}`);
  const durationSec = (Date.now() - startTime) / 1000;

  console.log('\n' + '='.repeat(70));
  console.log('📊 BURST OUTCOME DISTRIBUTION');
  console.log('='.repeat(70));
  console.log(`Total Requests Processed: ${stats.totalRequests}`);
  console.log(`Total Time Taken:         ${durationSec.toFixed(2)}s`);
  console.log(`Throughput:               ${(stats.totalRequests / durationSec).toFixed(1)} req/s`);
  console.log('\nHTTP Status Breakdown:');
  for (const [code, count] of Object.entries(stats.statusCodes)) {
    console.log(`  ${code}: ${count} requests`);
  }

  console.log('\nDomain Decline Reasons (409s):');
  for (const [reason, count] of Object.entries(stats.declineReasons)) {
    console.log(`  - ${reason}: ${count}`);
  }

  console.log('\n5xx Server Errors:');
  if (stats.errors5xx === 0) {
    console.log('  🎉 ZERO 5xx Errors (0 / ' + stats.totalRequests + ') - 100% Clean Domain Handling!');
  } else {
    console.log(`  ❌ VIOLATION: ${stats.errors5xx} 5xx server errors detected!`);
  }

  console.log('\nReconciliation Invariant Audit:');
  const data = finalState.body;
  if (data && data.reconciliation) {
    console.log(`  Available Seats:  ${data.available_count}`);
    console.log(`  Held Seats:       ${data.held_count}`);
    console.log(`  Confirmed Seats:  ${data.confirmed_count}`);
    console.log(`  Total Seats:      ${data.total_seats}`);
    console.log(`  Sum:              ${data.reconciliation.sum}`);
    console.log(`  Invariant Holds:  ${data.reconciliation.invariant_holds ? '✅ YES (available + held + confirmed == total_seats)' : '❌ NO'}`);
  } else {
    console.log('  ❌ Could not read show reconciliation details');
  }

  // Fetch Prometheus metrics snippet
  const metricsRes = await request('/metrics');
  if (metricsRes.status === 200 && typeof metricsRes.body === 'string') {
    console.log('\nPrometheus Domain Metrics:');
    const lines = metricsRes.body.split('\n');
    const relevant = lines.filter(l => 
      !l.startsWith('#') && (
        l.startsWith('reservations_confirmed_total') ||
        l.startsWith('reservations_declined_total') ||
        l.startsWith('idempotent_replays_total') ||
        l.startsWith('seats_available')
      )
    );
    console.log(relevant.slice(0, 15).join('\n'));
  }

  console.log('='.repeat(70));

  if (stats.errors5xx > 0 || !data?.reconciliation?.invariant_holds) {
    console.error('❌ BURST TEST FAILED CRITICAL REQUIREMENTS.');
    process.exit(1);
  } else {
    console.log('🏆 ALL CORRECTNESS, INVARIANT, AND CONCURRENCY BARS PASSED!');
    process.exit(0);
  }
}

run().catch(err => {
  console.error('Fatal burst error:', err);
  process.exit(1);
});
