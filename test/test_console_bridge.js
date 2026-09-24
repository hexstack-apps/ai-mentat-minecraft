'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const CB = require('../lib/console-bridge');

// ─── Reading the server's stdout ──────────────────────────────────────────

test('parseLine reads a player join, with and without an xuid', () => {
  const a = CB.parseLine('[2026-04-03 01:22:31:456 INFO] Player connected: Steve, xuid: 2535401234567890');
  assert.strictEqual(a.event, 'PlayerJoin');
  assert.strictEqual(a.player, 'Steve');
  assert.strictEqual(a.xuid, '2535401234567890');

  const b = CB.parseLine('[2026-04-03 01:22:31:456 INFO] Player connected: Steve');
  assert.strictEqual(b.event, 'PlayerJoin');
  assert.strictEqual(b.player, 'Steve');
});

test('parseLine reads a player leave', () => {
  const e = CB.parseLine('[2026-04-03 01:30:02:001 INFO] Player disconnected: Alex, xuid: 999');
  assert.strictEqual(e.event, 'PlayerLeave');
  assert.strictEqual(e.player, 'Alex');
});

test('parseLine reads chat, keeping the message intact', () => {
  const e = CB.parseLine('[2026-04-03 01:23:02:001 INFO] [Chat] Steve: hello there: friend');
  assert.strictEqual(e.event, 'PlayerMessage');
  assert.strictEqual(e.player, 'Steve');
  assert.strictEqual(e.message, 'hello there: friend', 'a colon in the message must not truncate it');
});

test('parseLine handles a gamertag containing spaces', () => {
  const e = CB.parseLine('[2026-04-03 01:22:31:456 INFO] Player connected: Big Steve 99, xuid: 1');
  assert.strictEqual(e.player, 'Big Steve 99');
});

test('parseLine reports server lifecycle lines', () => {
  assert.strictEqual(CB.parseLine('[2026-04-03 01:22:00:000 INFO] Server started.').event, 'ServerReady');
  assert.strictEqual(CB.parseLine('[2026-04-03 02:00:00:000 INFO] Stopping server...').event, 'ServerStopping');
});

test('parseLine ignores ordinary log noise', () => {
  for (const line of [
    '[2026-04-03 01:22:00:000 INFO] Level Name: Bedrock level',
    '[2026-04-03 01:22:00:000 INFO] Game mode: 0 Survival',
    '',
    '   ',
    null,
    undefined,
  ]) {
    assert.strictEqual(CB.parseLine(line), null, String(line));
  }
});

// ─── Chunk boundaries ─────────────────────────────────────────────────────
// stdout arrives in arbitrary chunks, and a boundary lands mid-line often
// enough that dropping the partial line loses real joins and chat.

test('parseChunk carries a partial line over to the next chunk', () => {
  const first = CB.parseChunk('[2026-04-03 01:22:31:456 INFO] Player conn');
  assert.deepStrictEqual(first.events, []);
  assert.ok(first.remainder.length > 0);

  const second = CB.parseChunk('ected: Steve, xuid: 1\n', first.remainder);
  assert.strictEqual(second.events.length, 1);
  assert.strictEqual(second.events[0].player, 'Steve');
  assert.strictEqual(second.remainder, '');
});

test('parseChunk returns every event in a multi-line chunk', () => {
  const chunk = [
    '[2026-04-03 01:22:31:456 INFO] Player connected: Steve, xuid: 1',
    '[2026-04-03 01:22:32:456 INFO] Level Name: Bedrock level',
    '[2026-04-03 01:22:33:456 INFO] [Chat] Steve: hi',
    '',
  ].join('\n');
  const { events } = CB.parseChunk(chunk);
  assert.deepStrictEqual(events.map((e) => e.event), ['PlayerJoin', 'PlayerMessage']);
});

test('parseChunk handles CRLF output', () => {
  const { events } = CB.parseChunk('[2026-04-03 01:22:31:456 INFO] Player connected: Steve\r\n');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].player, 'Steve');
});

// ─── Writing to the server's stdin ────────────────────────────────────────
// Everything written here runs with operator authority.

test('buildCommand terminates the command with a newline', () => {
  assert.strictEqual(CB.buildCommand('say hello'), 'say hello\n');
});

test('buildCommand strips the leading slash users habitually type', () => {
  assert.strictEqual(CB.buildCommand('/say hello'), 'say hello\n');
});

test('buildCommand refuses an embedded newline rather than stripping it', () => {
  // Stripping and continuing would run a command the caller never checked.
  assert.throws(() => CB.buildCommand('say hi\nop Steve'), /may not contain a newline/);
  assert.throws(() => CB.buildCommand('say hi\r\nstop'), /may not contain a newline/);
});

test('buildCommand refuses a null byte and empty input', () => {
  assert.throws(() => CB.buildCommand('say \0hi'), /null byte/);
  assert.throws(() => CB.buildCommand('   '), /empty/);
  assert.throws(() => CB.buildCommand(''), /empty/);
  assert.throws(() => CB.buildCommand(null), TypeError);
});

test('buildCommand passes through characters BDS treats as ordinary text', () => {
  // BDS is not a shell — these are legitimate chat content.
  assert.strictEqual(CB.buildCommand('say hi; bye `x` && $y'), 'say hi; bye `x` && $y\n');
});

// ─── The transport's honest limits ────────────────────────────────────────

test('only the three stdout-observable events are supported', () => {
  assert.deepStrictEqual(CB.SUPPORTED_EVENTS, ['PlayerJoin', 'PlayerLeave', 'PlayerMessage']);
  assert.strictEqual(CB.isSupportedEvent('PlayerJoin'), true);
  assert.strictEqual(CB.isSupportedEvent('PlayerTransform'), false,
    'mcpews events that BDS never prints must not read as available');
  assert.strictEqual(CB.isSupportedEvent('BlockPlaced'), false);
});
