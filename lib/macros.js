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
 * Action type -> BDS command.
 *
 * `run_command` is the deliberate escape hatch for anything not modelled here;
 * it is validated exactly like the rest, just not shaped.
 */
const ACTIONS = {
  say: { fields: ['message'], build: (c) => `say ${c.message}` },
  give: {
    fields: ['target', 'item'],
    build: (c) => `give ${c.target} ${c.item} ${int(c.amount, 1)} ${int(c.data, 0)}`,
  },
  tp: { fields: ['target', 'destination'], build: (c) => `tp ${c.target} ${c.destination}` },
  kill: { fields: ['target'], build: (c) => `kill ${c.target}` },
  gamemode: { fields: ['target', 'mode'], build: (c) => `gamemode ${c.mode} ${c.target}` },
  effect: {
    fields: ['target', 'effect'],
    build: (c) => `effect ${c.target} ${c.effect} ${int(c.duration, 30)} ${int(c.amplifier, 0)}`,
  },
  time_set: { fields: ['value'], build: (c) => `time set ${c.value}` },
  weather: { fields: ['type'], build: (c) => `weather ${c.type}` },
  summon: { fields: ['entity'], build: (c) => `summon ${c.entity}${c.position ? ` ${c.position}` : ''}` },
  title: { fields: ['target', 'message'], build: (c) => `title ${c.target} actionbar ${c.message}` },
  playsound: { fields: ['sound', 'target'], build: (c) => `playsound ${c.sound} ${c.target}` },
  spawn_particles: { fields: ['particle'], build: (c) => `particle ${c.particle}${c.position ? ` ${c.position}` : ''}` },
  run_command: { fields: ['command'], build: (c) => String(c.command).replace(/^\//, '') },
};

const CONDITIONS = ['dimension_is', 'player_is', 'message_contains', 'message_matches'];

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
  for (const field of spec.fields) {
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
