'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const RT = require('../lib/runtime');

// ─── Runtime selection ───────────────────────────────────────────────────
// Mojang ships no macOS BDS build; that absence is why the container runtime
// exists and why "Macs supported" is the app's headline feature.

test('macOS uses the container runtime, Windows and Linux run BDS natively', () => {
  assert.strictEqual(RT.runtimeFor('darwin'), 'container');
  assert.strictEqual(RT.runtimeFor('win32'), 'native');
  assert.strictEqual(RT.runtimeFor('linux'), 'native');
});

// ─── Lima home ───────────────────────────────────────────────────────────

test('lima home is short by design', () => {
  const home = RT.limaHome('/Users/x');
  assert.strictEqual(home, path.join('/Users/x', '.mc-lima'));
  // Lima puts its control socket inside its home; macOS UNIX_PATH_MAX is 104
  // bytes, and overrunning it fails as a confusing "socket path too long".
  assert.ok(home.length < 40, 'a long lima home overruns UNIX_PATH_MAX');
});

test('limaEnv sets LIMA_HOME on every call', () => {
  const env = RT.limaEnv('/Users/x', { PATH: '/bin' });
  assert.strictEqual(env.LIMA_HOME, '/Users/x/.mc-lima');
  assert.strictEqual(env.PATH, '/bin', 'the base environment must survive');
});

// ─── nerdctl ─────────────────────────────────────────────────────────────

test('nerdctl runs through the VM with sudo', () => {
  // containerd is a system service in this VM, not rootless.
  assert.deepStrictEqual(RT.nerdctlArgs(['ps']), ['shell', 'mc', 'sudo', 'nerdctl', 'ps']);
  assert.throws(() => RT.nerdctlArgs('ps'), TypeError);
});

test('the console pipe attaches to stdin of the running container', () => {
  const args = RT.consolePipeArgs();
  assert.ok(args.includes('exec'));
  assert.ok(args.includes('-i'), '-i is what keeps the console writable');
  assert.ok(args.includes(RT.CONTAINER_NAME));
});

// ─── VM listing ──────────────────────────────────────────────────────────
// `limactl list --json` emits JSONL: one object per line, not an array.

test('parseVmList reads multiple VMs from JSONL output', () => {
  const out = '{"name":"mc","status":"Running"}\n{"name":"other","status":"Stopped"}\n';
  const { vms, skipped } = RT.parseVmList(out);
  assert.strictEqual(vms.length, 2, 'a single JSON.parse of the whole blob fails here');
  assert.deepStrictEqual(skipped, []);
});

test('parseVmList skips a malformed line and records it, rather than aborting', () => {
  const out = '{"name":"mc","status":"Running"}\nnot json\n{"name":"b","status":"Stopped"}\n';
  const { vms, skipped } = RT.parseVmList(out);
  assert.strictEqual(vms.length, 2, 'good lines must still parse');
  assert.strictEqual(skipped.length, 1);
});

test('vmStatus reports a string, never a boolean', () => {
  const out = '{"name":"mc","status":"Stopped"}\n';
  assert.strictEqual(RT.vmStatus(out), 'Stopped');
  assert.strictEqual(RT.vmStatus('{"name":"other","status":"Running"}\n'), 'Absent');
  assert.strictEqual(RT.vmStatus(''), 'Absent');
});

test('a VM entry with no status is Unknown, never Running', () => {
  // Defaulting to Running would make the app try to use a dead VM.
  assert.strictEqual(RT.vmStatus('{"name":"mc"}\n'), 'Unknown');
});

test('only Running counts as usable', () => {
  assert.strictEqual(RT.isVmUsable('Running'), true);
  for (const status of ['Stopped', 'Broken', 'Absent', 'Unknown']) {
    assert.strictEqual(RT.isVmUsable(status), false, status);
  }
});

// ─── limactl resolution ──────────────────────────────────────────────────

test('the bundled limactl wins over anything installed', () => {
  const found = RT.resolveLimactl({
    bundledPath: '/app/lima-bin/limactl',
    exists: () => true,
    canRun: () => true,
  });
  assert.strictEqual(found, '/app/lima-bin/limactl',
    'behaviour must not change based on what the user happens to have installed');
});

test('a present-but-unrunnable binary does not abort the search', () => {
  // It is as useless as a missing one; the search continues.
  const found = RT.resolveLimactl({
    bundledPath: '/app/lima-bin/limactl',
    exists: (p) => p === '/app/lima-bin/limactl' || p === '/opt/homebrew/bin/limactl',
    canRun: (p) => p === '/opt/homebrew/bin/limactl',
  });
  assert.strictEqual(found, '/opt/homebrew/bin/limactl');
});

test('Homebrew locations are reachable for a Finder-launched app', () => {
  // A GUI app inherits a launchd PATH without /opt/homebrew/bin, so a working
  // `brew install lima` was reported as "not installed".
  const found = RT.resolveLimactl({
    bundledPath: null,
    exists: (p) => p === '/opt/homebrew/bin/limactl',
    canRun: (p) => p === '/opt/homebrew/bin/limactl',
  });
  assert.strictEqual(found, '/opt/homebrew/bin/limactl');
});

test('resolveLimactl returns null when Lima is genuinely absent', () => {
  assert.strictEqual(RT.resolveLimactl({ bundledPath: null, exists: () => false, canRun: () => false }), null);
});

test('the missing-Lima error names both remedies', () => {
  const msg = RT.limactlMissingError();
  assert.ok(msg.includes('npm run download:lima'));
  assert.ok(msg.includes('brew install lima'));
});

// ─── Container console quoting ───────────────────────────────────────────
// Container-mode commands pass through `sh` inside the VM, so a bare
// interpolation would be a command-injection point.

test('shellQuote survives an apostrophe in ordinary chat', () => {
  // `say don't` must not close the quote and let the rest run as shell.
  assert.strictEqual(RT.shellQuote("say don't"), "'say don'\\''t'");
});

test('sendCommandLine wraps the command for the console shell', () => {
  assert.strictEqual(RT.sendCommandLine('list'), "send-command 'list'\n");
  assert.strictEqual(RT.sendCommandLine('list\n'), "send-command 'list'\n",
    'an already-terminated command must not double up');
});

test('sendCommandLine refuses an embedded newline', () => {
  // It would be a second shell command, not a second Minecraft command.
  assert.throws(() => RT.sendCommandLine('list\nrm -rf /'), /may not contain a newline/);
});

test('sendCommandLine neutralises shell metacharacters', () => {
  const line = RT.sendCommandLine('say $(whoami) `id` && stop');
  assert.ok(line.startsWith("send-command '"));
  assert.ok(line.includes('$(whoami)'), 'the text is preserved verbatim inside quotes');
  assert.ok(!line.includes("' &&"), 'and never escapes the quoting');
});

test('the container log source follows stdout with a bounded tail', () => {
  const args = RT.containerLogArgs();
  assert.ok(args.includes('logs'));
  assert.ok(args.includes('-f'));
  assert.ok(args.includes('--tail'));
});
