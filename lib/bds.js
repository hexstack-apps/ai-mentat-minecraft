'use strict';
//
// Bedrock Dedicated Server configuration and distribution.
//
// BDS is configured entirely through `server.properties`, a flat key=value
// file it reads once at startup. The GUI edits a handful of those keys, so the
// file has to survive a round trip: a user who hand-edited a key this app does
// not model must not lose it when the app saves.

const CONTAINER_IMAGE = 'itzg/minecraft-bedrock-server';

/** The keys the GUI exposes, with the values BDS itself defaults to. */
const DEFAULTS = {
  'server-name': 'Hexstack Mentat Server',
  'gamemode': 'survival',
  'difficulty': 'easy',
  'allow-cheats': 'false',
  'max-players': '10',
  'online-mode': 'true',
  'allow-list': 'false',
  'server-port': '19132',
  'server-portv6': '19133',
  'view-distance': '32',
  'tick-distance': '4',
  'player-idle-timeout': '30',
  'level-name': 'Bedrock level',
  'level-seed': '',
  'default-player-permission-level': 'member',
};

const ENUMS = {
  'gamemode': ['survival', 'creative', 'adventure'],
  'difficulty': ['peaceful', 'easy', 'normal', 'hard'],
  'default-player-permission-level': ['visitor', 'member', 'operator'],
  'allow-cheats': ['true', 'false'],
  'online-mode': ['true', 'false'],
  'allow-list': ['true', 'false'],
};

/**
 * Parse server.properties, preserving nothing but the data.
 * Blank lines and `#` comments are skipped; a line with no `=` is not a
 * property and is ignored rather than treated as a key with an empty value.
 */
function parseServerProperties(text) {
  const props = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    props[key] = trimmed.slice(eq + 1).trim();
  }
  return props;
}

/**
 * Render server.properties from `existing` overlaid with `changes`.
 *
 * `existing` is passed in so keys this app does not model are carried through
 * untouched — losing a hand-set `texturepack-required` on every save would be
 * a data-loss bug the user could only find by reading the file.
 */
function renderServerProperties(existing = {}, changes = {}) {
  const merged = { ...DEFAULTS, ...existing, ...changes };
  const keys = Object.keys(merged).sort();
  const lines = ['# Managed by Hexstack Mentat MCBES. Unknown keys are preserved.'];
  for (const key of keys) {
    const value = merged[key];
    if (value === null || value === undefined) continue;
    lines.push(`${key}=${value}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Validate one property before it reaches the file.
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function validateProperty(key, value) {
  const str = String(value);
  if (/[\r\n]/.test(str)) {
    // A newline would create a second, unintended property line.
    return { ok: false, error: `${key}: value may not contain a newline` };
  }
  if (ENUMS[key] && !ENUMS[key].includes(str)) {
    return { ok: false, error: `${key}: must be one of ${ENUMS[key].join(', ')}` };
  }
  if (key === 'server-port' || key === 'server-portv6') {
    const port = Number(str);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: `${key}: must be a port between 1 and 65535` };
    }
  }
  if (key === 'max-players') {
    const n = Number(str);
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'max-players: must be at least 1' };
  }
  return { ok: true };
}

/** Validate a whole change set; returns every problem, not just the first. */
function validateChanges(changes) {
  const errors = [];
  for (const [key, value] of Object.entries(changes || {})) {
    const result = validateProperty(key, value);
    if (!result.ok) errors.push(result.error);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Mojang's download URL for a BDS version.
 *
 * There is no macOS artifact — that absence is the reason for the container
 * runtime, so asking for one is a programming error, not a runtime condition.
 */
function downloadUrl(version, platform = process.platform) {
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(String(version || ''))) {
    throw new Error(`downloadUrl: ${JSON.stringify(version)} is not a BDS version`);
  }
  const dir = platform === 'win32' ? 'bin-win' : platform === 'linux' ? 'bin-linux' : null;
  if (!dir) {
    throw new Error(`downloadUrl: Mojang ships no BDS build for ${platform} — use the container runtime`);
  }
  return `https://www.minecraft.net/bedrockdedicatedserver/bin/${dir}/bedrock-server-${version}.zip`;
}

/** Pull a version out of a BDS zip name or download URL. */
function parseVersion(text) {
  const m = String(text || '').match(/bedrock-server-(\d+\.\d+\.\d+(?:\.\d+)?)\.zip/);
  return m ? m[1] : null;
}

/**
 * argv to create the Bedrock container.
 *
 * `-i` keeps stdin open for the console bridge — without it the server has no
 * console to write to and every macro and command silently does nothing.
 * The port is published as UDP: Bedrock is RakNet over UDP, and a TCP
 * publish produces a server that looks up and accepts no players.
 */
function containerCreateArgs({ dataDir, port, eulaAccepted = true, image = CONTAINER_IMAGE }) {
  if (!dataDir) throw new Error('containerCreateArgs: dataDir is required');
  const portResult = validateProperty('server-port', port);
  if (!portResult.ok) throw new Error(`containerCreateArgs: ${portResult.error}`);
  return [
    'run', '-d', '-i',
    '--name', 'mc-bedrock',
    '-p', `${port}:${port}/udp`,
    '-v', `${dataDir}:/data`,
    '-e', `EULA=${eulaAccepted ? 'TRUE' : 'FALSE'}`,
    image,
  ];
}

module.exports = {
  CONTAINER_IMAGE,
  DEFAULTS,
  ENUMS,
  parseServerProperties,
  renderServerProperties,
  validateProperty,
  validateChanges,
  downloadUrl,
  parseVersion,
  containerCreateArgs,
};
