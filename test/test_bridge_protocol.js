'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const B = require('../lib/bridge-protocol');

const TOKEN = 'a'.repeat(64);

// ─── Authorization ───────────────────────────────────────────────────────
// Every request here runs a command with operator authority, and loopback is
// not a boundary against the local machine.

test('a correct token is accepted', () => {
  assert.deepStrictEqual(B.authorize({ [B.TOKEN_HEADER]: TOKEN }, TOKEN), { ok: true });
});

test('the token header is matched case-insensitively', () => {
  assert.strictEqual(B.authorize({ 'X-Mentat-Token': TOKEN }, TOKEN).ok, true);
});

test('a wrong, missing or truncated token is rejected with 401', () => {
  for (const headers of [{}, { [B.TOKEN_HEADER]: '' }, { [B.TOKEN_HEADER]: 'b'.repeat(64) }, { [B.TOKEN_HEADER]: TOKEN.slice(0, 32) }]) {
    const r = B.authorize(headers, TOKEN);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 401);
  }
});

test('a request carrying a browser Origin is refused outright', () => {
  // Closes the browser-driven CSRF / DNS-rebinding path: no legitimate client
  // is a web page, so the token is not even consulted.
  const r = B.authorize({ origin: 'http://evil.example', [B.TOKEN_HEADER]: TOKEN }, TOKEN);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 403);
});

test('authorization fails closed when the server has no token', () => {
  assert.strictEqual(B.authorize({ [B.TOKEN_HEADER]: TOKEN }, undefined).ok, false);
  assert.strictEqual(B.authorize({ [B.TOKEN_HEADER]: TOKEN }, '').ok, false);
});

test('an empty header does not match an empty server token', () => {
  // The dangerous case: two empty strings are equal-length, so a raw
  // timingSafeEqual on them returns TRUE. If the token file failed to read,
  // the server would then accept any client that sends an empty header.
  assert.strictEqual(B.tokenMatches('', ''), false);
  assert.strictEqual(B.authorize({ [B.TOKEN_HEADER]: '' }, '').ok, false);
});

test('tokenMatches compares without leaking length mismatches as a throw', () => {
  assert.strictEqual(B.tokenMatches('abc', 'abcd'), false);
  assert.strictEqual(B.tokenMatches(null, TOKEN), false);
  assert.strictEqual(B.tokenMatches(TOKEN, TOKEN), true);
});

test('generated tokens are unique', () => {
  assert.notStrictEqual(B.generateToken(), B.generateToken());
  assert.strictEqual(B.generateToken().length, 64);
});

// ─── Request validation ──────────────────────────────────────────────────

test('validateRequest accepts the documented ops', () => {
  assert.strictEqual(B.validateRequest({ op: 'players' }).ok, true);
  assert.strictEqual(B.validateRequest({ op: 'command', command: 'list' }).ok, true);
  assert.strictEqual(B.validateRequest('{"op":"status"}').ok, true);
});

test('validateRequest rejects an unknown op and names the valid ones', () => {
  const r = B.validateRequest({ op: 'rm_rf' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unknown op/);
  assert.match(r.error, /command, say, players, events, status/);
});

test('validateRequest requires the payload each op needs', () => {
  assert.strictEqual(B.validateRequest({ op: 'command' }).ok, false);
  assert.strictEqual(B.validateRequest({ op: 'command', command: 42 }).ok, false);
  assert.strictEqual(B.validateRequest({ op: 'say' }).ok, false);
});

test('validateRequest reports malformed bodies instead of throwing', () => {
  for (const body of ['{ truncated', null, [], 'null', 7]) {
    assert.strictEqual(B.validateRequest(body).ok, false, String(body));
  }
});

// ─── Player roster ───────────────────────────────────────────────────────
// There is no "list players" push on the console bridge; the roster is
// accumulated from join/leave lines.

test('the roster tracks joins and leaves', () => {
  const roster = new B.PlayerRoster();
  roster.apply({ event: 'PlayerJoin', player: 'Steve', xuid: '1' });
  roster.apply({ event: 'PlayerJoin', player: 'Alex', xuid: '2' });
  assert.strictEqual(roster.count, 2);
  roster.apply({ event: 'PlayerLeave', player: 'Steve' });
  assert.deepStrictEqual(roster.list().map((p) => p.player), ['Alex']);
});

test('a rejoin does not duplicate a player', () => {
  const roster = new B.PlayerRoster();
  roster.apply({ event: 'PlayerJoin', player: 'Steve' });
  roster.apply({ event: 'PlayerJoin', player: 'Steve' });
  assert.strictEqual(roster.count, 1);
});

test('the roster clears when the server stops', () => {
  // Keeping names across a restart would report players who are not there.
  const roster = new B.PlayerRoster();
  roster.apply({ event: 'PlayerJoin', player: 'Steve' });
  roster.apply({ event: 'ServerStopping' });
  assert.strictEqual(roster.count, 0);
});

test('the roster ignores events it does not track and malformed input', () => {
  const roster = new B.PlayerRoster();
  for (const e of [{ event: 'PlayerMessage', player: 'Steve', message: 'hi' }, null, {}, { event: 'PlayerJoin' }]) {
    roster.apply(e);
  }
  assert.strictEqual(roster.count, 0, 'chat must not add a player, nor must a join with no name');
});

// ─── Event buffer ────────────────────────────────────────────────────────

test('the event buffer keeps the newest events and drops the oldest', () => {
  // Unbounded would be a slow memory leak on a busy server.
  const buffer = new B.EventBuffer(3);
  for (let i = 1; i <= 5; i++) buffer.push({ event: 'PlayerMessage', message: String(i) });
  assert.deepStrictEqual(buffer.recent(10).map((e) => e.message), ['3', '4', '5']);
});

test('recent returns a copy, not the live buffer', () => {
  const buffer = new B.EventBuffer(5);
  buffer.push({ event: 'PlayerJoin', player: 'Steve' });
  buffer.recent(5).push({ event: 'injected' });
  assert.strictEqual(buffer.recent(5).length, 1);
});

test('recent clamps a request larger than the buffer', () => {
  const buffer = new B.EventBuffer(5);
  buffer.push({ event: 'PlayerJoin' });
  assert.strictEqual(buffer.recent(100).length, 1);
  assert.strictEqual(buffer.recent(0).length, 0);
});

test('EventBuffer rejects a nonsense limit', () => {
  assert.throws(() => new B.EventBuffer(0), RangeError);
  assert.throws(() => new B.EventBuffer(-1), RangeError);
  assert.throws(() => new B.EventBuffer(1.5), RangeError);
});
