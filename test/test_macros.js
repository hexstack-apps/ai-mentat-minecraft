'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const M = require('../lib/macros');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/event-macro.macro'), 'utf8');

/** A minimal runnable v2 macro, in the shape the surviving files use. */
function macro(rows) {
  return { id: 'm1', name: 'Test', version: 2, triggerMode: 'event', rows, variables: [] };
}
const row = (over = {}) => ({
  id: 'r1',
  when: { id: 'w1', type: 'trigger:on_player_join', label: 'Player Join', config: { eventName: 'PlayerJoin' } },
  conditions: [],
  actions: [{ id: 'a1', type: 'say', label: 'Say', config: { message: 'welcome' } }],
  results: [],
  enabled: true,
  ...over,
});

// ─── Parsing the real format ─────────────────────────────────────────────

test('the surviving v2 macro file parses', () => {
  const { ok, macro: doc, errors } = M.parseMacro(FIXTURE);
  assert.strictEqual(ok, true, errors.join('; '));
  assert.strictEqual(doc.version, 2);
  assert.ok(Array.isArray(doc.rows));
});

test('a macro of another version is refused, not guessed at', () => {
  // v1 and v3 have a different row shape; mis-compiling would run commands the
  // author never wrote.
  for (const version of [1, 3, undefined, '2']) {
    const r = M.parseMacro({ version, rows: [] });
    assert.strictEqual(r.ok, false, String(version));
    assert.match(r.errors[0], /unsupported macro version/);
  }
});

test('parseMacro reports broken input instead of throwing', () => {
  assert.strictEqual(M.parseMacro('{ truncated').ok, false);
  assert.strictEqual(M.parseMacro(null).ok, false);
  assert.strictEqual(M.parseMacro([]).ok, false);
  assert.strictEqual(M.parseMacro({ version: 2 }).ok, false, 'no rows array');
});

// ─── The transport's limits, made visible ────────────────────────────────

test('a row listening for an event BDS never prints is reported, not silently dead', () => {
  // The surviving fixture listens for PlayerTransform, which the console
  // bridge cannot observe. Registering a listener that can never fire is the
  // failure this prevents.
  const { macro: doc } = M.parseMacro(FIXTURE);
  // The fixture row is saved disabled, and "disabled" takes precedence as a
  // reason because the author chose it. Enable it to reach the trigger check.
  const support = M.rowSupport({ ...doc.rows[0], enabled: true });
  assert.strictEqual(support.runnable, false);
  assert.strictEqual(support.event, 'PlayerTransform');
  assert.match(support.reason, /not observable through the BDS console bridge/);
  assert.match(support.reason, /PlayerJoin, PlayerLeave, PlayerMessage/,
    'the reason must name what IS available');
});

test('rowSupport accepts a row on a real console event', () => {
  const support = M.rowSupport(row());
  assert.deepStrictEqual(support, { runnable: true, event: 'PlayerJoin', reason: null });
});

test('rowSupport explains every way a row can be unrunnable', () => {
  assert.match(M.rowSupport(row({ enabled: false })).reason, /disabled/);
  assert.match(M.rowSupport(row({ when: null })).reason, /no trigger/);
  assert.match(M.rowSupport(row({ actions: [] })).reason, /no actions/);
  assert.match(M.rowSupport(null).reason, /empty row/);
});

test('rowEventName falls back to the trigger type when config is bare', () => {
  assert.strictEqual(M.rowEventName({ when: { type: 'trigger:on_player_join', config: {} } }), 'PlayerJoin');
  assert.strictEqual(M.rowEventName({ when: { type: 'trigger:on_player_message', config: {} } }), 'PlayerMessage');
  assert.strictEqual(M.rowEventName({ when: null }), null);
});

// ─── Compiling actions to console commands ───────────────────────────────

test('compileAction builds the documented commands', () => {
  assert.strictEqual(M.compileAction({ type: 'say', config: { message: 'hi' } }), 'say hi');
  assert.strictEqual(
    M.compileAction({ type: 'give', config: { target: '@s', item: 'diamond_pickaxe', amount: 1, data: 0 } }),
    'give @s diamond_pickaxe 1 0');
  assert.strictEqual(M.compileAction({ type: 'gamemode', config: { target: '@a', mode: 'creative' } }),
    'gamemode creative @a');
  assert.strictEqual(M.compileAction({ type: 'time_set', config: { value: 'day' } }), 'time set day');
});

test('give defaults amount and data rather than emitting undefined', () => {
  assert.strictEqual(
    M.compileAction({ type: 'give', config: { target: '@s', item: 'apple' } }),
    'give @s apple 1 0');
});

test('run_command is the escape hatch and drops a leading slash', () => {
  assert.strictEqual(M.compileAction({ type: 'run_command', config: { command: '/kick Steve' } }), 'kick Steve');
});

test('an unknown action type is refused, never guessed', () => {
  assert.throws(() => M.compileAction({ type: 'teleport_to_moon', config: {} }),
    /unknown action type .* refusing to guess/);
  assert.throws(() => M.compileAction({ config: {} }), /no type/);
});

test('a missing required field is refused', () => {
  assert.throws(() => M.compileAction({ type: 'say', config: {} }), /missing required field "message"/);
  assert.throws(() => M.compileAction({ type: 'give', config: { target: '@s' } }), /missing required field "item"/);
  assert.throws(() => M.compileAction({ type: 'say', config: { message: '' } }), /missing required field/);
});

test('a newline in any field is refused — it would inject a second command', () => {
  assert.throws(() => M.compileAction({ type: 'say', config: { message: 'hi\nop Steve' } }),
    /unusable value/);
  assert.throws(() => M.compileAction({ type: 'run_command', config: { command: 'list\nstop' } }),
    /unusable value/);
});

test('an invalid target is refused', () => {
  for (const target of ['@x', '@s; stop', 'a'.repeat(40), '@a[tag=x]\n']) {
    assert.throws(() => M.compileAction({ type: 'kill', config: { target } }), /invalid target|unusable value/, target);
  }
});

test('legitimate selectors and gamertags are accepted', () => {
  for (const target of ['@s', '@a', '@p', '@r', '@e', '@a[tag=admin]', 'Steve', '"Big Steve 99"']) {
    assert.strictEqual(M.isValidTarget(target), true, target);
  }
});

// ─── Compiling a whole macro ─────────────────────────────────────────────

test('compileMacro groups runnable rows by event and lists what it skipped', () => {
  const doc = macro([
    row(),
    row({ id: 'r2', when: { type: 'trigger:on_player_transform', config: { eventName: 'PlayerTransform' } } }),
    row({ id: 'r3', enabled: false }),
  ]);
  const { byEvent, skipped } = M.compileMacro(doc);
  assert.deepStrictEqual(byEvent.PlayerJoin, [{ rowId: 'r1', commands: ['say welcome'] }]);
  assert.strictEqual(skipped.length, 2);
  assert.deepStrictEqual(skipped.map((s) => s.rowId), ['r2', 'r3']);
});

test('compileMacro runs results after actions', () => {
  const doc = macro([row({
    actions: [{ type: 'give', config: { target: '@s', item: 'apple' } }],
    results: [{ type: 'spawn_particles', config: { particle: 'minecraft:heart_particle' } }],
  })]);
  const { byEvent } = M.compileMacro(doc);
  assert.deepStrictEqual(byEvent.PlayerJoin[0].commands,
    ['give @s apple 1 0', 'particle minecraft:heart_particle']);
});

test('a row with one bad action is skipped whole, not run halfway', () => {
  // Running half a row leaves the world in a state the author never described.
  const doc = macro([row({
    actions: [
      { type: 'say', config: { message: 'first' } },
      { type: 'nonsense', config: {} },
    ],
  })]);
  const { byEvent, skipped } = M.compileMacro(doc);
  assert.strictEqual(byEvent.PlayerJoin, undefined, 'no partial row may be scheduled');
  assert.strictEqual(skipped.length, 1);
  assert.match(skipped[0].reason, /unknown action type/);
});

// ─── Conditions ──────────────────────────────────────────────────────────

test('no conditions means the row always fires', () => {
  assert.strictEqual(M.conditionsMet(row(), { event: 'PlayerJoin', player: 'Steve' }), true);
});

test('player_is and message_contains gate on the event payload', () => {
  const r = row({ conditions: [{ type: 'player_is', config: { player: 'Steve' } }] });
  assert.strictEqual(M.conditionsMet(r, { player: 'Steve' }), true);
  assert.strictEqual(M.conditionsMet(r, { player: 'Alex' }), false);

  const c = row({ conditions: [{ type: 'message_contains', config: { text: 'help' } }] });
  assert.strictEqual(M.conditionsMet(c, { message: 'i need help now' }), true);
  assert.strictEqual(M.conditionsMet(c, { message: 'hello' }), false);
});

test('negate and joinOperator are honoured', () => {
  const negated = row({ conditions: [{ type: 'player_is', config: { player: 'Steve' }, negate: true }] });
  assert.strictEqual(M.conditionsMet(negated, { player: 'Steve' }), false);

  const ored = row({
    conditions: [
      { type: 'player_is', config: { player: 'Steve' } },
      { type: 'player_is', config: { player: 'Alex' }, joinOperator: 'OR' },
    ],
  });
  assert.strictEqual(M.conditionsMet(ored, { player: 'Alex' }), true);

  const anded = row({
    conditions: [
      { type: 'player_is', config: { player: 'Steve' } },
      { type: 'message_contains', config: { text: 'hi' }, joinOperator: 'AND' },
    ],
  });
  assert.strictEqual(M.conditionsMet(anded, { player: 'Steve', message: 'nope' }), false);
});

test('an unknown condition type fails closed', () => {
  // It must not silently pass and run actions the author gated.
  const r = row({ conditions: [{ type: 'phase_of_moon_is', config: {} }] });
  assert.strictEqual(M.conditionsMet(r, {}), false);
});

test('an unconfigured dimension_is is treated as any, a configured one fails closed', () => {
  // The console bridge does not report a dimension. The surviving fixture has
  // the unconfigured form.
  assert.strictEqual(M.conditionsMet(row({ conditions: [{ type: 'dimension_is', config: {} }] }), {}), true);
  assert.strictEqual(
    M.conditionsMet(row({ conditions: [{ type: 'dimension_is', config: { dimension: 'nether' } }] }), {}), false);
});

// ─── Placeholders ────────────────────────────────────────────────────────

test('interpolate fills the event payload into a command', () => {
  assert.strictEqual(M.interpolate('say welcome {player}', { player: 'Steve' }), 'say welcome Steve');
  assert.strictEqual(M.interpolate('say you said {message}', { message: 'hi' }), 'say you said hi');
});

test('interpolate never leaves a literal placeholder in a live command', () => {
  assert.strictEqual(M.interpolate('say welcome {player}', {}), 'say welcome ');
  assert.strictEqual(M.interpolate('say {player}', { player: 'a\nb' }), 'say ',
    'an unsafe value is dropped, not injected');
});
