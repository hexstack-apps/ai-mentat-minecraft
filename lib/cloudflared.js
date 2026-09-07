'use strict';
//
// Pure cloudflared config parsing and rendering.
//
// Shared design with ai-mentat-n8n's copy — the ingress parser is the same
// code — but the service scheme differs and that difference matters:
//
//   n8n       service: http://localhost:5678     (HTTP, ordinary tunnel)
//   Bedrock   service: udp://localhost:19132     (RakNet over UDP)
//
// WHAT A UDP TUNNEL CAN AND CANNOT DO
// -----------------------------------
// Cloudflare routes UDP through a tunnel only for PRIVATE network access —
// clients reach it via WARP, or via Spectrum on an enterprise plan. There is
// no public UDP ingress on a standard plan, so a Bedrock client on a plain
// internet connection cannot join through this tunnel. The wizard still
// builds a correct config (it is what a WARP-connected group of players
// actually uses), and the FAQ says plainly that the alternative for public
// play is a forwarded port. Generating an http:// ingress for a UDP game
// would produce a tunnel that connects and accepts no players, which is a
// worse answer than an honest limitation.

const CLOUDFLARED_SERVICE_404 = 'http_status:404';

/** Strip a trailing `# comment` and surrounding quotes/space from a scalar. */
function cleanScalar(raw) {
  if (typeof raw !== 'string') return '';
  let v = raw.trim();
  // A '#' only starts a comment when preceded by whitespace or at the start,
  // so a value like `a#b` (legal in YAML) survives.
  const hash = v.search(/(^|\s)#/);
  if (hash !== -1) v = v.slice(0, hash === 0 ? 0 : hash).trim();
  return v.replace(/^["']|["']$/g, '').trim();
}

/**
 * Parse a cloudflared config.yml far enough to answer: which hostname is
 * pointed at our local port, and under which tunnel?
 *
 * Deliberately not a full YAML parser — no dependency for this, and a partial
 * parse must never throw on a malformed file: a bad config should read as
 * "not configured", not crash the tunnel tab.
 *
 * @returns {{tunnel: string|null, credentialsFile: string|null,
 *            ingress: Array<{hostname: string|null, service: string|null}>,
 *            hostname: string|null, configured: boolean}}
 */
function parseTunnelConfig(text, port, scheme = 'udp') {
  const empty = { tunnel: null, credentialsFile: null, ingress: [], hostname: null, configured: false };
  if (typeof text !== 'string' || !text.trim()) return empty;

  let tunnel = null;
  let credentialsFile = null;
  const ingress = [];
  let inIngress = false;
  let current = null;

  const pushCurrent = () => {
    if (current) ingress.push(current);
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;

    // Top-level keys are unindented; reaching one ends the ingress block.
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (top) {
      pushCurrent();
      inIngress = top[1] === 'ingress';
      if (top[1] === 'tunnel') tunnel = cleanScalar(top[2]) || null;
      if (top[1] === 'credentials-file') credentialsFile = cleanScalar(top[2]) || null;
      continue;
    }

    if (!inIngress) continue;

    // `- hostname: x` / `- service: y` opens a new ingress entry.
    const item = line.match(/^\s*-\s*(.*)$/);
    if (item) {
      pushCurrent();
      current = { hostname: null, service: null };
      const inline = item[1].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (inline) applyKey(current, inline[1], inline[2]);
      continue;
    }

    // A continuation key belongs to the entry opened above it. Order-free:
    // hostname-then-service and service-then-hostname both parse.
    const kv = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv && current) applyKey(current, kv[1], kv[2]);
  }
  pushCurrent();

  const wanted = `${scheme}://localhost:${port}`;
  const match = ingress.find((e) => e.service && normalizeService(e.service) === wanted && e.hostname);
  const hostname = match ? match.hostname : null;

  return {
    tunnel,
    credentialsFile,
    ingress,
    hostname,
    // All three are required: a tunnel id with no hostname routes nothing, and
    // a hostname with no tunnel id cannot be run.
    configured: !!(tunnel && hostname),
  };
}

function applyKey(entry, key, value) {
  const v = cleanScalar(value);
  if (key === 'hostname') entry.hostname = v || null;
  if (key === 'service') entry.service = v || null;
}

/** `udp://127.0.0.1:19132` and `udp://localhost:19132` mean the same thing. */
function normalizeService(service) {
  return String(service).trim().replace('127.0.0.1', 'localhost').replace(/\/+$/, '');
}

/**
 * Render the config.yml this app manages.
 *
 * The catch-all `http_status:404` entry is mandatory — cloudflared refuses to
 * start a config whose ingress list has no final catch-all rule.
 */
function renderTunnelConfig({ tunnelId, credentialsFile, hostname, port, scheme = 'udp' }) {
  if (!tunnelId) throw new Error('renderTunnelConfig: tunnelId is required');
  if (!hostname) throw new Error('renderTunnelConfig: hostname is required');
  return [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsFile}`,
    '',
    'ingress:',
    `  - hostname: ${hostname}`,
    `    service: ${scheme}://localhost:${port}`,
    `  - service: ${CLOUDFLARED_SERVICE_404}`,
    '',
    'metrics: 127.0.0.1:0',
    '',
  ].join('\n');
}

/** Pull the tunnel UUID out of `cloudflared tunnel create` output. */
function parseTunnelId(output) {
  const m = String(output || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

/**
 * Reject anything that is not a plain DNS hostname before it reaches a shell
 * command line or a config file. `cloudflared tunnel route dns` and the
 * generated YAML both take this value, so an unvalidated string is an
 * injection point as well as a corrupt-config source.
 */
function isValidHostname(value) {
  if (typeof value !== 'string') return false;
  const host = value.trim();
  if (!host || host.length > 253) return false;
  if (host.startsWith('-') || host.endsWith('-') || host.endsWith('.')) return false;
  // Needs at least one dot: a tunnel must point at a real FQDN.
  if (!host.includes('.')) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host);
}

/** cloudflared logs this line once a connection is registered with the edge. */
function isTunnelConnectedLine(text) {
  return typeof text === 'string' && text.includes('Registered tunnel connection');
}

module.exports = {
  parseTunnelConfig,
  renderTunnelConfig,
  parseTunnelId,
  isValidHostname,
  isTunnelConnectedLine,
  normalizeService,
  cleanScalar,
  CLOUDFLARED_SERVICE_404,
};
