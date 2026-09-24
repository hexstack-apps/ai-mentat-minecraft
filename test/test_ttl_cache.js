'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { memoize } = require('../lib/ttl-cache');

/** Controllable clock, so nothing here sleeps. */
function fakeClock(start = 1000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test('the underlying probe runs once within the TTL', () => {
  // This is the bug it fixes: a 5s renderer poll fired a 20s limactl probe on
  // every tick and blocked the main process until the app stopped responding.
  const clock = fakeClock();
  let calls = 0;
  const probe = memoize(() => { calls += 1; return 'Running'; }, 30_000, clock.now);

  for (let i = 0; i < 10; i++) assert.strictEqual(probe(), 'Running');
  assert.strictEqual(calls, 1, 'ten polls inside the TTL must cost one probe');
});

test('the probe runs again once the TTL expires', () => {
  const clock = fakeClock();
  let calls = 0;
  const probe = memoize(() => { calls += 1; return calls; }, 30_000, clock.now);

  assert.strictEqual(probe(), 1);
  clock.advance(29_999);
  assert.strictEqual(probe(), 1, 'still fresh');
  clock.advance(2);
  assert.strictEqual(probe(), 2, 'expired, so it probes again');
});

test('freshness is stamped when the probe FINISHES, not when it starts', () => {
  // The probe must outlast the TTL for this to discriminate: a 20s probe under
  // a 10s TTL is already "expired" the instant it returns if the timestamp was
  // taken before the call, so every poll re-probes — the exact thundering herd
  // this cache exists to prevent.
  const clock = fakeClock();
  let calls = 0;
  const probe = memoize(() => { calls += 1; clock.advance(20_000); return 'slow'; }, 10_000, clock.now);

  probe();
  assert.strictEqual(calls, 1);
  probe();
  assert.strictEqual(calls, 1, 'the 20s the probe itself took must not count against its TTL');
});

test('invalidate forces the next call to probe for real', () => {
  // Called after start/stop/install, so the UI updates immediately when an
  // action really did change the answer.
  const clock = fakeClock();
  let calls = 0;
  const probe = memoize(() => { calls += 1; return calls; }, 30_000, clock.now);

  assert.strictEqual(probe(), 1);
  assert.strictEqual(probe(), 1);
  probe.invalidate();
  assert.strictEqual(probe(), 2);
});

test('isFresh reports whether a call would hit the cache', () => {
  const clock = fakeClock();
  const probe = memoize(() => 'x', 10_000, clock.now);
  assert.strictEqual(probe.isFresh(), false, 'nothing cached yet');
  probe();
  assert.strictEqual(probe.isFresh(), true);
  clock.advance(10_001);
  assert.strictEqual(probe.isFresh(), false);
});

test('arguments are passed through to the probe', () => {
  const clock = fakeClock();
  const probe = memoize((a, b) => `${a}:${b}`, 1000, clock.now);
  assert.strictEqual(probe('vm', 'mc'), 'vm:mc');
});

test('a zero TTL means no caching at all', () => {
  const clock = fakeClock();
  let calls = 0;
  const probe = memoize(() => { calls += 1; return calls; }, 0, clock.now);
  probe(); probe();
  assert.strictEqual(calls, 2);
});

test('memoize rejects nonsense configuration', () => {
  assert.throws(() => memoize('not a function', 100), TypeError);
  assert.throws(() => memoize(() => 1, -1), RangeError);
  assert.throws(() => memoize(() => 1, NaN), RangeError);
});
