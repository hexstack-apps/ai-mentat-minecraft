'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const BDS = require('../lib/bds');

// ─── server.properties round trip ────────────────────────────────────────

test('parseServerProperties reads keys and skips comments and blanks', () => {
  const props = BDS.parseServerProperties([
    '# comment',
    '',
    'server-name=My Server',
    'gamemode=creative',
    'not a property line',
    'level-seed=',
  ].join('\n'));
  assert.strictEqual(props['server-name'], 'My Server');
  assert.strictEqual(props.gamemode, 'creative');
  assert.strictEqual(props['level-seed'], '');
  assert.ok(!('not a property line' in props));
});

test('parseServerProperties keeps a value containing an equals sign', () => {
  const props = BDS.parseServerProperties('level-seed=a=b\n');
  assert.strictEqual(props['level-seed'], 'a=b');
});

test('renderServerProperties preserves keys the GUI does not model', () => {
  // Losing a hand-set key on every save is data loss the user could only find
  // by reading the file.
  const existing = BDS.parseServerProperties('texturepack-required=true\nserver-name=Old\n');
  const out = BDS.renderServerProperties(existing, { 'server-name': 'New' });
  const back = BDS.parseServerProperties(out);
  assert.strictEqual(back['texturepack-required'], 'true');
  assert.strictEqual(back['server-name'], 'New');
});

test('renderServerProperties fills in the BDS defaults', () => {
  const back = BDS.parseServerProperties(BDS.renderServerProperties());
  assert.strictEqual(back['server-port'], '19132');
  assert.strictEqual(back.gamemode, 'survival');
  assert.strictEqual(back['online-mode'], 'true');
});

test('render output round-trips through the parser unchanged', () => {
  const first = BDS.renderServerProperties({}, { 'server-name': 'Round Trip', 'max-players': '20' });
  const second = BDS.renderServerProperties(BDS.parseServerProperties(first));
  assert.strictEqual(BDS.parseServerProperties(second)['server-name'], 'Round Trip');
  assert.strictEqual(BDS.parseServerProperties(second)['max-players'], '20');
});

// ─── Validation ──────────────────────────────────────────────────────────

test('a newline in a property value is rejected', () => {
  // It would create a second, unintended property line.
  const r = BDS.validateProperty('server-name', 'Evil\nallow-cheats=true');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /newline/);
});

test('enum properties reject values BDS would not understand', () => {
  assert.strictEqual(BDS.validateProperty('gamemode', 'creative').ok, true);
  assert.strictEqual(BDS.validateProperty('gamemode', 'spectator').ok, false);
  assert.strictEqual(BDS.validateProperty('difficulty', 'hard').ok, true);
  assert.strictEqual(BDS.validateProperty('difficulty', 'nightmare').ok, false);
  assert.strictEqual(BDS.validateProperty('allow-cheats', 'yes').ok, false);
});

test('ports must be in range', () => {
  assert.strictEqual(BDS.validateProperty('server-port', '19132').ok, true);
  for (const port of ['0', '70000', '-1', 'abc', '19132.5']) {
    assert.strictEqual(BDS.validateProperty('server-port', port).ok, false, port);
  }
});

test('max-players must be at least one', () => {
  assert.strictEqual(BDS.validateProperty('max-players', '1').ok, true);
  assert.strictEqual(BDS.validateProperty('max-players', '0').ok, false);
});

test('validateChanges reports every problem, not just the first', () => {
  const r = BDS.validateChanges({ gamemode: 'nope', 'server-port': '0', 'server-name': 'fine' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors.length, 2);
});

// ─── Distribution ────────────────────────────────────────────────────────

test('downloadUrl points at the right Mojang artifact', () => {
  assert.match(BDS.downloadUrl('1.21.44.01', 'win32'), /bin-win\/bedrock-server-1\.21\.44\.01\.zip$/);
  assert.match(BDS.downloadUrl('1.21.44.01', 'linux'), /bin-linux\/bedrock-server-1\.21\.44\.01\.zip$/);
});

test('asking for a macOS BDS build is an error, not an empty result', () => {
  // There is no such artifact; that absence is why the container runtime exists.
  assert.throws(() => BDS.downloadUrl('1.21.44.01', 'darwin'), /ships no BDS build for darwin/);
});

test('downloadUrl rejects a version that is not a version', () => {
  for (const v of ['latest', '', null, '1.21', '../../etc/passwd']) {
    assert.throws(() => BDS.downloadUrl(v, 'linux'), /is not a BDS version/, String(v));
  }
});

test('parseVersion recovers the version from a zip name', () => {
  assert.strictEqual(BDS.parseVersion('bedrock-server-1.21.44.01.zip'), '1.21.44.01');
  assert.strictEqual(BDS.parseVersion(BDS.downloadUrl('1.20.1.02', 'linux')), '1.20.1.02');
  assert.strictEqual(BDS.parseVersion('something-else.zip'), null);
});

// ─── Container creation ──────────────────────────────────────────────────

test('the container keeps stdin open and publishes UDP', () => {
  const args = BDS.containerCreateArgs({ dataDir: '/data/mc', port: 19132 });
  assert.ok(args.includes('-i'), 'without -i the server has no console to write to');
  assert.ok(args.includes('19132:19132/udp'), 'Bedrock is RakNet over UDP; a TCP publish accepts no players');
  assert.ok(args.includes('/data/mc:/data'));
  assert.ok(args.includes('EULA=TRUE'));
});

test('containerCreateArgs refuses an invalid port or a missing data dir', () => {
  assert.throws(() => BDS.containerCreateArgs({ dataDir: '/d', port: 0 }), /port/);
  assert.throws(() => BDS.containerCreateArgs({ port: 19132 }), /dataDir is required/);
});
