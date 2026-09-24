'use strict';
//
// BDS console bridge — pure parsing and command construction.
//
// WHY A CONSOLE BRIDGE AND NOT mcpews
// -----------------------------------
// The obvious way to drive a Bedrock server is the mcpews WebSocket protocol,
// which exposes ~45 event types. It was rejected: it requires a player to type
// `/wsserver <url>` in-game every session, and it authenticates as a player,
// so it does not work on an offline-mode server at all.
//
// This bridge instead speaks to the server the way an operator does — writing
// commands to BDS's stdin and reading its stdout. It auto-connects the moment
// the server starts, needs nothing typed in-game, and is indifferent to
// online/offline mode because no player authentication is involved.
//
// bedrock-protocol was also evaluated and rejected: it needs native C++
// compilation (raknet-native + cmake), which does not work without a build
// toolchain on the user's machine.
//
// THE COST, WHICH CALLERS MUST RESPECT
// ------------------------------------
// Only what BDS actually prints to stdout is observable: player join, player
// leave and chat. The other ~42 mcpews events (block placement, player
// movement, item use) DO NOT EXIST here. Code must say so out loud rather
// than registering a listener that can never fire — see lib/macros.js.

/** The events this transport can actually deliver. */
const SUPPORTED_EVENTS = ['PlayerJoin', 'PlayerLeave', 'PlayerMessage'];

// BDS log lines look like:
//   [2026-04-03 01:22:31:456 INFO] Player connected: Steve, xuid: 25398744...
//   [2026-04-03 01:22:31:456 INFO] Player disconnected: Steve, xuid: 25398744...
//   [2026-04-03 01:23:02:001 INFO] [Chat] Steve: hello world
// The timestamp/level prefix is stripped first so the patterns below stay
// readable and version drift in the prefix format does not break them.
const PREFIX = /^\[[\d\-: ]+(?:\s+\w+)?\]\s*/;

const PATTERNS = [
  { event: 'PlayerJoin', re: /^Player connected:\s*(?<player>.+?)(?:,\s*xuid:\s*(?<xuid>\d+))?\s*$/ },
  { event: 'PlayerLeave', re: /^Player disconnected:\s*(?<player>.+?)(?:,\s*xuid:\s*(?<xuid>\d+))?\s*$/ },
  { event: 'PlayerMessage', re: /^\[Chat\]\s*(?<player>[^:]+):\s*(?<message>.*)$/ },
];

/** Server-lifecycle lines worth surfacing in the GUI. */
const READY_LINE = /Server started\./i;
const STOPPING_LINE = /Stopping server/i;

/**
 * Parse one line of BDS stdout.
 * @returns {{event: string, player?: string, xuid?: string, message?: string, raw: string}|null}
 *   null for the vast majority of lines, which are ordinary log noise.
 */
function parseLine(line) {
  if (typeof line !== 'string') return null;
  const text = line.replace(PREFIX, '').trim();
  if (!text) return null;

  for (const { event, re } of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const out = { event, raw: line };
    if (m.groups.player) out.player = m.groups.player.trim();
    if (m.groups.xuid) out.xuid = m.groups.xuid;
    if (m.groups.message !== undefined) out.message = m.groups.message;
    return out;
  }
  if (READY_LINE.test(text)) return { event: 'ServerReady', raw: line };
  if (STOPPING_LINE.test(text)) return { event: 'ServerStopping', raw: line };
  return null;
}

/**
 * Split a stdout chunk into events.
 *
 * Returns leftover text as `remainder`: a chunk boundary lands mid-line often
 * enough that dropping the partial line loses real joins and chat messages.
 * Callers keep the remainder and prepend it to the next chunk.
 */
function parseChunk(chunk, carry = '') {
  const text = carry + String(chunk);
  const lines = text.split(/\r?\n/);
  const remainder = lines.pop() ?? '';
  const events = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed) events.push(parsed);
  }
  return { events, remainder };
}

/**
 * Validate and terminate a command for BDS stdin.
 *
 * Everything written here is executed by the server with operator authority,
 * and a newline inside the string would smuggle a SECOND command past any
 * caller-side check — so an embedded newline is a hard rejection, not
 * something to strip and continue with.
 *
 * BDS console commands carry no leading slash; a pasted `/say hi` is the most
 * common user mistake and is corrected rather than rejected.
 */
function buildCommand(command) {
  if (typeof command !== 'string') throw new TypeError('buildCommand: command must be a string');
  const trimmed = command.trim();
  if (!trimmed) throw new Error('buildCommand: command is empty');
  if (/[\r\n]/.test(trimmed)) {
    throw new Error('buildCommand: a command may not contain a newline (it would inject a second command)');
  }
  if (/\0/.test(trimmed)) throw new Error('buildCommand: a command may not contain a null byte');
  return `${trimmed.replace(/^\//, '')}\n`;
}

/** True when this transport can deliver the named event at all. */
function isSupportedEvent(name) {
  return SUPPORTED_EVENTS.includes(name);
}

module.exports = {
  SUPPORTED_EVENTS,
  parseLine,
  parseChunk,
  buildCommand,
  isSupportedEvent,
};
