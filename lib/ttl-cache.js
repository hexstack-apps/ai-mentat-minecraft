'use strict';
//
// Time-to-live memoisation for expensive probes.
//
// WHY THIS EXISTS
// ---------------
// `server:status` answers a poll from the renderer. It used to call
// `limactl list --json` and `nerdctl images` on every tick — synchronous
// subprocesses, each spawning a VM round trip with a 20s timeout.
//
// That was survivable on a healthy machine and fatal on a real one: with the
// leftover `mc` VM in a Broken state, every probe ran to its timeout, the main
// process blocked for tens of seconds at a stretch, and the app stopped
// responding entirely (the window went with it). 38 probes fired in one short
// session, all failing identically.
//
// Nothing about a VM's state or an installed container image changes between
// two 5-second polls in a way a user could notice, so the answer is cached.
// `invalidate()` is called after an action that CAN change the answer — start,
// stop, install — so the UI still updates immediately when it matters.

/**
 * Wrap a synchronous function so it runs at most once per `ttlMs`.
 *
 * @param {Function} fn        the expensive probe
 * @param {number} ttlMs       how long an answer stays fresh
 * @param {Function} [clock]   injectable time source, for tests
 * @returns {Function & {invalidate: Function, isFresh: Function}}
 */
function memoize(fn, ttlMs, clock = Date.now) {
  if (typeof fn !== 'function') throw new TypeError('memoize: fn must be a function');
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError('memoize: ttlMs must be a non-negative number');

  let cachedAt = null;
  let value;

  const wrapped = function wrapped(...args) {
    const now = clock();
    if (cachedAt !== null && now - cachedAt < ttlMs) return value;
    value = fn(...args);
    // Stamp the time AFTER the call: a probe that takes 20s should be fresh
    // for ttl from when it finished, not from when it started, or a slow probe
    // is stale the moment it returns and runs again immediately.
    cachedAt = clock();
    return value;
  };

  /** Drop the cached answer, so the next call probes for real. */
  wrapped.invalidate = () => { cachedAt = null; value = undefined; };

  /** Whether a call right now would be served from cache. */
  wrapped.isFresh = () => cachedAt !== null && clock() - cachedAt < ttlMs;

  return wrapped;
}

module.exports = { memoize };
