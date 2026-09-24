'use strict';
//
// The local control protocol between the app and its clients.
//
// The app opens a loopback control port (19134 by default) that two clients
// use: `bedrock-mcp-server.mjs`, the stdio MCP server Claude Code talks to,
// and the macro engine. Both need the same two things — send a console command,
// and observe events — so the surface is deliberately tiny.
//
// The original module was named `wsServer.js` (it began life speaking mcpews
// over WebSocket). Its role is unchanged; the transport is now plain HTTP+JSON
// on loopback, which needs no dependency and no handshake code.
//
// WHY THERE IS A TOKEN ON A LOOPBACK PORT
// ---------------------------------------
// Every request here runs a Minecraft command with operator authority. A port
// bound to 127.0.0.1 is not a security boundary against the local machine: any
// process, and any web page the user visits (via a form POST or a
// DNS-rebinding attack), can reach it. So requests carry a shared secret that
// is generated per install, stored 0600, and handed to the MCP server through
// its environment. Requests are also rejected if they carry a browser `Origin`
// at all — no legitimate client is a web page.

const crypto = require('crypto');

const DEFAULT_PORT = 19134;
const TOKEN_HEADER = 'x-mentat-token';
const TOKEN_ENV = 'MENTAT_BRIDGE_TOKEN';
const TOKEN_FILE = 'bridge-token';

function generateToken(randomBytes = crypto.randomBytes) {
  return randomBytes(32).toString('hex');
}

/**
 * Constant-time token comparison.
 * A plain `===` on a secret leaks its prefix through timing, which is cheap to
 * avoid and awkward to retrofit.
 */
function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Is this request allowed to drive the server?
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
function authorize(headers = {}, expectedToken) {
  const lower = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;

  // No legitimate client is a web page. Refusing any request that carries an
  // Origin closes the browser-driven CSRF / DNS-rebinding path outright.
  if (lower.origin) return { ok: false, status: 403, error: 'origin-bearing requests are not accepted' };

  if (!tokenMatches(lower[TOKEN_HEADER], expectedToken)) {
    return { ok: false, status: 401, error: 'invalid or missing token' };
  }
  return { ok: true };
}

const COMMANDS = ['command', 'say', 'players', 'events', 'status'];

/**
 * Validate a request body.
 * @returns {{ok: true, request: object} | {ok: false, error: string}}
 */
function validateRequest(body) {
  let parsed = body;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (e) {
      return { ok: false, error: `body is not JSON: ${e.message}` };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const { op } = parsed;
  if (!COMMANDS.includes(op)) {
    return { ok: false, error: `unknown op ${JSON.stringify(op)} — expected one of ${COMMANDS.join(', ')}` };
  }
  if (op === 'command' && typeof parsed.command !== 'string') {
    return { ok: false, error: 'op "command" requires a command string' };
  }
  if (op === 'say' && typeof parsed.message !== 'string') {
    return { ok: false, error: 'op "say" requires a message string' };
  }
  return { ok: true, request: parsed };
}

/**
 * Who is online, derived from console events.
 *
 * The console bridge has no "list players" push, so the roster is accumulated
 * from join/leave lines. It is reset when the server stops: keeping stale
 * names across a restart would report players who are not there.
 */
class PlayerRoster {
  constructor() {
    this.players = new Map();
  }

  apply(event) {
    if (!event || typeof event.event !== 'string') return;
    switch (event.event) {
      case 'PlayerJoin':
        if (event.player) this.players.set(event.player, { player: event.player, xuid: event.xuid || null, since: Date.now() });
        break;
      case 'PlayerLeave':
        if (event.player) this.players.delete(event.player);
        break;
      case 'ServerStopping':
        this.players.clear();
        break;
      default:
        break;
    }
  }

  list() {
    return [...this.players.values()];
  }

  get count() {
    return this.players.size;
  }

  clear() {
    this.players.clear();
  }
}

/**
 * A bounded ring of recent events.
 *
 * Bounded because this is a long-running process and a busy server emits chat
 * continuously; an unbounded log is a slow memory leak. Trimmed from the front
 * so the newest events are the ones kept.
 */
class EventBuffer {
  constructor(limit = 500) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('EventBuffer: limit must be a positive integer');
    this.limit = limit;
    this.events = [];
  }

  push(event) {
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }

  /** Newest last. A copy, so callers cannot corrupt the buffer. */
  recent(count = 50) {
    const n = Math.max(0, Math.min(count, this.events.length));
    return this.events.slice(this.events.length - n);
  }

  clear() {
    this.events.length = 0;
  }
}

module.exports = {
  DEFAULT_PORT,
  TOKEN_HEADER,
  TOKEN_ENV,
  TOKEN_FILE,
  COMMANDS,
  generateToken,
  tokenMatches,
  authorize,
  validateRequest,
  PlayerRoster,
  EventBuffer,
};
