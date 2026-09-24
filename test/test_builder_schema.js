'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../lib/macros');
const { SUPPORTED_EVENTS } = require('../lib/console-bridge');

// ─── The schema the builder form is generated from ───────────────────────
// One table feeds both the compiler and the UI on purpose: a second table
// would drift, and the drift would be invisible.

test('the schema exposes every action type, and only real ones', () => {
  // Both directions matter: an extra type would draw a form the compiler
  // rejects, and a missing one would silently disappear from the dropdown with
  // nothing to notice it by.
  const schema = M.builderSchema();
  assert.deepStrictEqual(
    schema.actions.map((a) => a.type).sort(),
    Object.keys(M.ACTIONS).sort(),
  );
  for (const action of schema.actions) {
    assert.ok(action.label, `${action.type} needs a label for the dropdown`);
    assert.ok(Array.isArray(action.inputs) && action.inputs.length > 0, `${action.type} needs inputs`);
  }
});

test('requiredFields is derived from the inputs, not a second list', () => {
  // The duplication this replaces was the real risk: a form offering a field
  // the compiler ignores, or omitting one it demands.
  for (const [type, spec] of Object.entries(M.ACTIONS)) {
    const derived = M.requiredFields(type);
    const expected = spec.inputs.filter((i) => i.required).map((i) => i.name);
    assert.deepStrictEqual(derived, expected, type);
  }
  assert.deepStrictEqual(M.requiredFields('nonexistent'), []);
});

test('the builder only offers triggers the console bridge can deliver', () => {
  // This is what stops someone building a rule that can never fire.
  const events = M.builderSchema().triggers.map((t) => t.event);
  assert.deepStrictEqual(events.slice().sort(), SUPPORTED_EVENTS.slice().sort());
});

test('each trigger declares the placeholders that are actually populated', () => {
  for (const trigger of M.builderSchema().triggers) {
    assert.ok(trigger.placeholders.includes('player'));
    if (trigger.event === 'PlayerMessage') assert.ok(trigger.placeholders.includes('message'));
  }
});

test('a trigger spec round-trips through rowEventName', () => {
  for (const trigger of M.builderSchema().triggers) {
    const row = { when: { type: trigger.type, config: { eventName: trigger.event } } };
    assert.strictEqual(M.rowEventName(row), trigger.event);
    // And still resolves with a bare config, as older saved files have.
    assert.strictEqual(M.rowEventName({ when: { type: trigger.type, config: {} } }), trigger.event);
  }
});

test('every schema condition is one conditionsMet understands', () => {
  for (const condition of M.builderSchema().conditions) {
    assert.ok(M.CONDITIONS.includes(condition.type), condition.type);
  }
});

test('dimension_is carries the note explaining it cannot match', () => {
  // The bridge reports no dimension, so a specific choice fails closed. Saying
  // that at the point of choosing beats a rule that silently never runs.
  const spec = M.builderSchema().conditions.find((c) => c.type === 'dimension_is');
  assert.match(spec.note, /does not report a dimension/);
});

// ─── Document constructors ───────────────────────────────────────────────

test('newMacro produces a document that parses as v2', () => {
  const doc = M.newMacro({ id: 'abc', name: 'Test' });
  const parsed = M.parseMacro(doc);
  assert.strictEqual(parsed.ok, true, parsed.errors.join('; '));
  assert.strictEqual(doc.version, M.SUPPORTED_VERSION);
  assert.deepStrictEqual(doc.rows, []);
});

test('newRow listens for a real event and compiles once given an action', () => {
  const doc = M.newMacro({ id: 'm', name: 'T' });
  const row = M.newRow({ id: 'r1', event: 'PlayerMessage' });
  row.actions = [M.newAction({ id: 'a1', type: 'say' })];
  row.actions[0].config.message = 'hi';
  doc.rows = [row];
  const { byEvent, skipped } = M.compileMacro(doc);
  assert.deepStrictEqual(skipped, []);
  assert.deepStrictEqual(byEvent.PlayerMessage[0].commands, ['say hi']);
});

test('newRow falls back to a valid trigger for an unknown event', () => {
  const row = M.newRow({ id: 'r', event: 'PlayerTransform' });
  assert.ok(SUPPORTED_EVENTS.includes(M.rowEventName(row)),
    'the builder must never construct a row that cannot fire');
});

test('newAction pre-fills declared defaults', () => {
  // Without this a freshly added `give` would fail its own preview.
  const give = M.newAction({ id: 'a', type: 'give' });
  assert.strictEqual(give.config.target, '@s');
  assert.strictEqual(give.config.amount, 1);
  assert.strictEqual(give.config.data, 0);
  // A select with no explicit default takes its first option.
  assert.strictEqual(M.newAction({ id: 'b', type: 'gamemode' }).config.mode, 'survival');
});

test('newAction refuses an unknown type', () => {
  assert.throws(() => M.newAction({ id: 'a', type: 'teleport_to_moon' }), /unknown action type/);
});

test('every action type can be constructed and compiled once required text is filled', () => {
  // Guards the whole vocabulary at once: a new action type with a broken
  // default or a field the build function does not read fails here.
  for (const spec of M.builderSchema().actions) {
    const action = M.newAction({ id: 'a', type: spec.type });
    for (const input of spec.inputs) {
      if (input.required && action.config[input.name] === undefined) {
        action.config[input.name] = input.type === 'number' ? 1 : 'x';
      }
    }
    const command = M.compileAction(action);
    assert.ok(typeof command === 'string' && command.length > 0, spec.type);
    assert.ok(!command.includes('undefined'), `${spec.type} compiled with an undefined field: ${command}`);
  }
});
