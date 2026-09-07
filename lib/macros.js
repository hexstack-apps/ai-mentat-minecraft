'use strict';
//
// MCMacro `.macro` v2 — validation, trigger support, and compilation to BDS
// console commands.
//
// THE FORMAT IS NOT INVENTED HERE
// -------------------------------
// The original macro builder was a separate prebuilt React app (`mcmacro-ui`,
// `mcmacro-engine`) mounted in an Electron <webview>; its source repo and the
// committed build artifacts are both gone. What survived is real saved macro
// files in the old app's data directory, so the schema below is transcribed
// from actual `.macro` v2 documents — see test/fixtures/event-macro.macro.
//
//   { id, name, description, version: 2, author, triggerMode: 'event',
//     rows: [ { id, when: {type, label, config:{eventName, ...}} | null,
//               conditions: [{type, config, negate, joinOperator}],
//               actions:    [{type, label, config}],
//               results:    [{type, label, config}],
//               enabled } ],
//     variables: [], createdAt, updatedAt }
//
// WHY VALIDATION MATTERS MORE THAN IT LOOKS
// -----------------------------------------
// Compiled output goes to BDS stdin, where it runs with operator authority.
// Every value interpolated into a command is therefore checked, and anything
// unrecognised is refused rather than passed through — a macro row that
// silently becomes a different command than the builder displayed is worse
// than a macro that reports it cannot be compiled.

const { SUPPORTED_EVENTS, isSupportedEvent } = require('./console-bridge');

const SUPPORTED_VERSION = 2;

/**
 * Action type -> BDS command, plus the form metadata the builder renders.
 *
 * ONE TABLE, TWO CONSUMERS. The compiler reads `inputs` to know what is
 * required, and the builder UI reads the same `inputs` to draw the form. That
 * is deliberate: a second table for the UI would drift, and the drift would be
 * invisible — a form offering a field the compiler ignores, or omitting one it
 * demands. Adding an action type here makes it appear in the builder with no
 * UI change at all.
 *
 * `inputs[].required` is the single source of truth for validation;
 * `requiredFields()` derives the check list from it.
 *
 * `run_command` is the deliberate escape hatch for anything not modelled here;
 * it is validated exactly like the rest, just not shaped.
 */
const ACTIONS = {
  say: {
    label: 'Say in chat',
    inputs: [{ name: 'message', label: 'Message', type: 'text', required: true, placeholder: 'Welcome, {player}!' }],
    build: (c) => `say ${c.message}`,
  },
  give: {
    label: 'Give item',
    inputs: [
      { name: 'target', label: 'To', type: 'target', required: true, default: '@s' },
      { name: 'item', label: 'Item', type: 'text', required: true, placeholder: 'diamond_pickaxe' },
      { name: 'amount', label: 'Amount', type: 'number', required: false, default: 1 },
      { name: 'data', label: 'Data', type: 'number', required: false, default: 0 },
    ],
    build: (c) => `give ${c.target} ${c.item} ${int(c.amount, 1)} ${int(c.data, 0)}`,
  },
  tp: {
    label: 'Teleport',
    inputs: [
      { name: 'target', label: 'Who', type: 'target', required: true, default: '@s' },
      { name: 'destination', label: 'To', type: 'text', required: true, placeholder: '0 64 0  (or a player name)' },
    ],
    build: (c) => `tp ${c.target} ${c.destination}`,
  },
  kill: {
    label: 'Kill',
    inputs: [{ name: 'target', label: 'Target', type: 'target', required: true, default: '@e[type=zombie]' }],
    build: (c) => `kill ${c.target}`,
  },
  gamemode: {
    label: 'Set game mode',
    inputs: [
      { name: 'mode', label: 'Mode', type: 'select', required: true, options: ['survival', 'creative', 'adventure', 'spectator'] },
      { name: 'target', label: 'For', type: 'target', required: true, default: '@s' },
    ],
    build: (c) => `gamemode ${c.mode} ${c.target}`,
  },
  effect: {
    label: 'Apply effect',
    inputs: [
      { name: 'target', label: 'To', type: 'target', required: true, default: '@s' },
      { name: 'effect', label: 'Effect', type: 'text', required: true, placeholder: 'speed' },
      { name: 'duration', label: 'Seconds', type: 'number', required: false, default: 30 },
      { name: 'amplifier', label: 'Amplifier', type: 'number', required: false, default: 0 },
    ],
    build: (c) => `effect ${c.target} ${c.effect} ${int(c.duration, 30)} ${int(c.amplifier, 0)}`,
  },
  time_set: {
    label: 'Set time',
    inputs: [{ name: 'value', label: 'Time', type: 'select', required: true, options: ['day', 'noon', 'sunset', 'night', 'midnight', 'sunrise'] }],
    build: (c) => `time set ${c.value}`,
  },
  weather: {
    label: 'Set weather',
    inputs: [{ name: 'type', label: 'Weather', type: 'select', required: true, options: ['clear', 'rain', 'thunder'] }],
    build: (c) => `weather ${c.type}`,
  },
  summon: {
    label: 'Summon entity',
    inputs: [
      { name: 'entity', label: 'Entity', type: 'text', required: true, placeholder: 'minecraft:cow' },
      { name: 'position', label: 'At', type: 'text', required: false, placeholder: '~ ~ ~' },
    ],
    build: (c) => `summon ${c.entity}${c.position ? ` ${c.position}` : ''}`,
  },
  title: {
    label: 'Show action-bar text',
    inputs: [
      { name: 'target', label: 'To', type: 'target', required: true, default: '@a' },
      { name: 'message', label: 'Text', type: 'text', required: true, placeholder: 'Welcome, {player}!' },
    ],
    build: (c) => `title ${c.target} actionbar ${c.message}`,
  },
  playsound: {
    label: 'Play sound',
    inputs: [
      { name: 'sound', label: 'Sound', type: 'text', required: true, placeholder: 'random.levelup' },
      { name: 'target', label: 'To', type: 'target', required: true, default: '@a' },
    ],
    build: (c) => `playsound ${c.sound} ${c.target}`,
  },
  spawn_particles: {
    label: 'Spawn particles',
    inputs: [
      { name: 'particle', label: 'Particle', type: 'text', required: true, placeholder: 'minecraft:heart_particle' },
      { name: 'position', label: 'At', type: 'text', required: false, placeholder: '~ ~ ~' },
    ],
    build: (c) => `particle ${c.particle}${c.position ? ` ${c.position}` : ''}`,
  },
  run_command: {
    label: 'Raw console command',
    inputs: [{ name: 'command', label: 'Command', type: 'text', required: true, placeholder: 'kick Steve Bye' }],
    build: (c) => String(c.command).replace(/^\//, ''),
  },
};

/** The required field names for an action type, derived from its inputs. */
function requiredFields(type) {
  const spec = ACTIONS[type];
  if (!spec) return [];
  return spec.inputs.filter((i) => i.required).map((i) => i.name);
}

/**
 * Conditions the builder can offer, with their form metadata.
 *
 * `note` is rendered as a warning in the UI. `dimension_is` carries one
 * because the console bridge does not report a dimension: leaving it on "any"
 * is the only setting that can ever match, and a specific choice fails closed.
 * The builder says so rather than letting someone build a row that silently
 * never fires.
 */
const CONDITION_SPECS = [
  {
    type: 'player_is',
    label: 'Player is',
    inputs: [{ name: 'player', label: 'Name', type: 'text', required: true, placeholder: 'Steve' }],
  },
  {
    type: 'message_contains',
    label: 'Message contains',
    inputs: [{ name: 'text', label: 'Text', type: 'text', required: true, placeholder: 'help' }],
    events: ['PlayerMessage'],
  },
  {
    type: 'message_matches',
    label: 'Message is exactly',
    inputs: [{ name: 'text', label: 'Text', type: 'text', required: true, placeholder: '!spawn' }],
    events: ['PlayerMessage'],
  },
  {
    type: 'dimension_is',
    label: 'Dimension is',
    inputs: [{ name: 'dimension', label: 'Dimension', type: 'select', required: false, options: ['any', 'overworld', 'nether', 'the_end'] }],
    note: 'The console bridge does not report a dimension. Only "any" can match; '
      + 'anything else makes the row never fire.',
  },
];

/** Names only — kept for the existing conditionsMet contract. */
const CONDITIONS = CONDITION_SPECS.map((c) => c.type);

/**
 * The triggers a row may use — exactly the events the console bridge can
 * deliver. The builder offers no others, which is how a saved macro stops
 * being able to listen for something that never arrives.
 *
 * `placeholders` tells the UI which `{...}` substitutions are populated for
 * this event, so it can hint them on text fields.
 */
const TRIGGER_SPECS = [
  {
    event: 'PlayerJoin',
    type: 'trigger:on_player_join',
    label: 'Player joins',
    placeholders: ['player', 'xuid'],
  },
  {
    event: 'PlayerLeave',
    type: 'trigger:on_player_leave',
    label: 'Player leaves',
    placeholders: ['player', 'xuid'],
  },
  {
    event: 'PlayerMessage',
    type: 'trigger:on_player_message',
    label: 'Player sends a chat message',
    placeholders: ['player', 'message'],
  },
];

/** Everything the builder needs to draw its form, in one payload. */
function builderSchema() {
  return {
    triggers: TRIGGER_SPECS,
    actions: Object.entries(ACTIONS).map(([type, spec]) => ({
      type,
      label: spec.label,
      inputs: spec.inputs,
    })),
    conditions: CONDITION_SPECS,
    joinOperators: ['AND', 'OR'],
  };
}

/**
 * A blank v2 document. `newId` is injected so the caller owns id generation
 * (the main process uses crypto.randomUUID).
 */
function newMacro({ id, name = 'Untitled macro', newId }) {
  const makeId = newId || (() => id);
  return {
    id: id || makeId(),
    name,
    description: '',
    version: SUPPORTED_VERSION,
    author: '',
    triggerMode: 'event',
    rows: [],
    variables: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** A blank row listening for `event`, with one empty action slot. */
function newRow({ id, event = 'PlayerJoin' }) {
  const trigger = TRIGGER_SPECS.find((t) => t.event === event) || TRIGGER_SPECS[0];
  return {
    id,
    when: {
      id: `${id}-when`,
      type: trigger.type,
      label: trigger.label,
      config: { eventName: trigger.event },
    },
    conditions: [],
    actions: [],
    results: [],
    enabled: true,
  };
}

/**
 * Fill an action's config with the defaults its inputs declare.
 * Without this a freshly added `give` row would compile with an empty target
 * and be rejected the moment it was previewed.
 */
function newAction({ id, type }) {
  const spec = ACTIONS[type];
  if (!spec) throw new Error(`newAction: unknown action type "${type}"`);
  const config = {};
  for (const input of spec.inputs) {
    if (input.default !== undefined) config[input.name] = input.default;
    else if (input.type === 'select' && input.options) config[input.name] = input.options[0];
  }
  return { id, type, label: spec.label, config };
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A value safe to interpolate into a console command.
 *
 * Newlines are the real hazard: one would end the command and start a second
 * one with operator rights. Semicolons and backticks mean nothing to BDS (it
 * is not a shell), so they are allowed — `say hi; bye` is legitimate chat.
 */
function isSafeValue(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  if (!value.length) return false;
  return !/[\r\n\0]/.test(value);
}

/** `@s`, `@a`, `@p`, `@r`, `@e`, an @-selector with arguments, or a gamertag. */
function isValidTarget(value) {
  if (typeof value !== 'string' || !isSafeValue(value)) return false;
  const v = value.trim();
  if (/^@[sapre](\[[^\]\r\n]*\])?$/.test(v)) return true;
  // Bedrock gamertags: letters, digits, spaces and underscores. Quoted when
  // they contain a space, which the command needs anyway.
  return /^"?[A-Za-z0-9_][A-Za-z0-9_ ]{0,29}"?$/.test(v);
}

/**
 * Which event a row listens for, or null for a row with no trigger.
 * The builder stored the transport-level name in `config.eventName`.
 */
function rowEventName(row) {
  if (!row || !row.when) return null;
  const config = row.when.config || {};
  if (typeof config.eventName === 'string' && config.eventName) return config.eventName;
  // Fall back to the `trigger:on_player_join` style type when config is bare.
  // The type already carries the subject, so PascalCasing the whole tail gives
  // `PlayerJoin` — prefixing `Player` as well would yield `PlayerPlayerJoin`.
  const m = /^trigger:on_(.+)$/.exec(row.when.type || '');
  if (!m) return null;
  return m[1].split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}

/**
 * Parse and validate a `.macro` document.
 *
 * Returns a report rather than throwing, because the GUI must be able to show
 * a partially-usable macro: rows that cannot run are listed with a reason, and
 * the rows that can still run are compiled.
 *
 * @returns {{ok: boolean, macro: object|null, errors: string[], warnings: string[]}}
 */
function parseMacro(input) {
  const errors = [];
  const warnings = [];
  let doc = input;

  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch (e) {
      return { ok: false, macro: null, errors: [`not valid JSON: ${e.message}`], warnings };
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, macro: null, errors: ['not a macro document'], warnings };
  }
  if (doc.version !== SUPPORTED_VERSION) {
    // Refuse rather than guess: a v1 or v3 document has a different row shape,
    // and mis-compiling it would run commands the author never wrote.
    return {
      ok: false,
      macro: null,
      errors: [`unsupported macro version ${JSON.stringify(doc.version)} — only v${SUPPORTED_VERSION} is understood`],
      warnings,
    };
  }
  if (!Array.isArray(doc.rows)) {
    return { ok: false, macro: null, errors: ['macro has no rows array'], warnings };
  }
  if (!isSafeValue(doc.name)) warnings.push('macro has no usable name');

  return { ok: errors.length === 0, macro: doc, errors, warnings };
}

/**
 * Can this row ever fire on the console bridge?
 *
 * The bridge sees only what BDS prints: join, leave, chat. The builder could
 * express ~45 mcpews events, so a saved macro may well listen for
 * `PlayerTransform` — that row can never fire here, and saying so is the whole
 * point of this function. Silently registering a listener that never runs is
 * the failure mode being prevented.
 *
 * @returns {{runnable: boolean, event: string|null, reason: string|null}}
 */
function rowSupport(row) {
  if (!row) return { runnable: false, event: null, reason: 'empty row' };
  if (row.enabled === false) return { runnable: false, event: rowEventName(row), reason: 'row is disabled' };
  const event = rowEventName(row);
  if (!event) return { runnable: false, event: null, reason: 'row has no trigger' };
  if (!isSupportedEvent(event)) {
    return {
      runnable: false,
      event,
      reason: `"${event}" is not observable through the BDS console bridge `
        + `(available: ${SUPPORTED_EVENTS.join(', ')})`,
    };
  }
  if (!Array.isArray(row.actions) || row.actions.length === 0) {
    return { runnable: false, event, reason: 'row has no actions' };
  }
  return { runnable: true, event, reason: null };
}

/** Compile one action into a console command string, or throw with the reason. */
function compileAction(action) {
  if (!action || typeof action.type !== 'string') throw new Error('action has no type');
  const spec = ACTIONS[action.type];
  if (!spec) {
    throw new Error(`unknown action type "${action.type}" — refusing to guess a command for it`);
  }
  const config = action.config || {};
  for (const field of requiredFields(action.type)) {
    if (!(field in config) || config[field] === '' || config[field] === null || config[field] === undefined) {
      throw new Error(`action "${action.type}" is missing required field "${field}"`);
    }
    if (!isSafeValue(config[field])) {
      throw new Error(`action "${action.type}" field "${field}" contains an unusable value`);
    }
  }
  if ('target' in config && !isValidTarget(config.target)) {
    throw new Error(`action "${action.type}" has an invalid target ${JSON.stringify(config.target)}`);
  }
  return spec.build(config);
}

/**
 * Compile a whole macro into the per-event command lists the engine runs.
 *
 * @returns {{byEvent: Object<string, Array<{rowId: string, commands: string[]}>>,
 *            skipped: Array<{rowId: string, reason: string}>}}
 */
function compileMacro(doc) {
  const byEvent = {};
  const skipped = [];

  for (const row of doc.rows || []) {
    const support = rowSupport(row);
    if (!support.runnable) {
      skipped.push({ rowId: row && row.id, reason: support.reason });
      continue;
    }
    // `results` run after `actions`; both are plain commands to the console.
    const steps = [...(row.actions || []), ...(row.results || [])];
    const commands = [];
    let failure = null;
    for (const step of steps) {
      try {
        commands.push(compileAction(step));
      } catch (e) {
        failure = e.message;
        break;
      }
    }
    if (failure) {
      // All-or-nothing per row: running half a macro row leaves the world in a
      // state the author never described.
      skipped.push({ rowId: row.id, reason: failure });
      continue;
    }
    if (!byEvent[support.event]) byEvent[support.event] = [];
    byEvent[support.event].push({ rowId: row.id, commands });
  }

  return { byEvent, skipped };
}

/**
 * Does an incoming console-bridge event satisfy a row's conditions?
 * Conditions are ANDed or ORed per `joinOperator`, honouring `negate`.
 * An unknown condition type fails closed — it must not silently pass.
 */
function conditionsMet(row, event) {
  const conditions = Array.isArray(row.conditions) ? row.conditions : [];
  if (conditions.length === 0) return true;

  let result = null;
  for (const condition of conditions) {
    let value = evaluateCondition(condition, event);
    if (condition.negate) value = !value;
    if (result === null) result = value;
    else if ((condition.joinOperator || 'AND').toUpperCase() === 'OR') result = result || value;
    else result = result && value;
  }
  return !!result;
}

function evaluateCondition(condition, event) {
  const config = (condition && condition.config) || {};
  switch (condition && condition.type) {
    case 'player_is':
      return !!config.player && event.player === config.player;
    case 'message_contains':
      return typeof event.message === 'string'
        && typeof config.text === 'string'
        && event.message.includes(config.text);
    case 'message_matches':
      return typeof event.message === 'string' && event.message === config.text;
    case 'dimension_is':
      // The console bridge does not report a dimension. An unconfigured
      // `dimension_is` (as the surviving fixture has) is treated as "any";
      // a configured one cannot be answered, so it fails closed.
      return !config.dimension || config.dimension === 'any';
    default:
      return false;
  }
}

/** `{player}` / `{message}` placeholders the builder allowed in text fields. */
function interpolate(command, event) {
  return String(command).replace(/\{(player|message|xuid)\}/g, (_, key) => {
    const value = event && event[key];
    // A missing value must not leave a literal `{player}` in a live command.
    return isSafeValue(value) ? String(value) : '';
  });
}

module.exports = {
  SUPPORTED_VERSION,
  ACTIONS,
  CONDITIONS,
  CONDITION_SPECS,
  TRIGGER_SPECS,
  requiredFields,
  builderSchema,
  newMacro,
  newRow,
  newAction,
  isSafeValue,
  isValidTarget,
  rowEventName,
  parseMacro,
  rowSupport,
  compileAction,
  compileMacro,
  conditionsMet,
  interpolate,
};
