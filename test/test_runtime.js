'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
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



// ─── nerdctl ─────────────────────────────────────────────────────────────


test('the console pipe attaches to stdin of the running container', () => {
  const args = RT.consolePipeArgs();
  assert.ok(args.includes('exec'));
  assert.ok(args.includes('-i'), '-i is what keeps the console writable');
  assert.ok(args.includes(RT.CONTAINER_NAME));
});

// ─── VM listing ──────────────────────────────────────────────────────────
// `limactl list --json` emits JSONL: one object per line, not an array.






// ─── limactl resolution ──────────────────────────────────────────────────






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
