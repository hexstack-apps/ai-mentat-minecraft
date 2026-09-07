'use strict';
//
// Where the Bedrock Dedicated Server actually runs, and how to talk to it.
//
// Mojang ships BDS as a Windows binary and a Linux binary. There is NO macOS
// build — which is the entire reason this app exists and why "🍏 Macs
// supported" is the headline feature. So there are two runtimes:
//
//   native     Windows / Linux — BDS is spawned directly, commands go to the
//              child process's own stdin.
//   container  macOS — BDS runs in a Linux container inside a Lima VM, and
//              commands go through a PERSISTENT `nerdctl exec -i` stdin pipe.
//              A fresh `exec` per command would attach to a new process each
//              time and never reach the running server's console.
//
// Lima specifics, all of them load-bearing:
//   * vmType `vz` — Apple's Virtualization.framework. No QEMU to install.
//   * LIMA_HOME is `~/.mc-lima`, deliberately SHORT. Lima puts its control
//     socket inside its home, and a longer path overruns UNIX_PATH_MAX (104
//     bytes on macOS), which fails as a confusing "socket path too long".
//   * every nerdctl call needs `sudo`: containerd runs as a system service
//     here, not rootless.
//   * the VM persists across app restarts; only the container is stopped on
//     exit, because booting a VM is slow and booting a container is not.

const path = require('path');

const VM_NAME = 'mc';
const LIMA_DIR_NAME = '.mc-lima';
const CONTAINER_NAME = 'mc-bedrock';
/** Bedrock's default port. UDP — RakNet, not TCP. */
const BEDROCK_PORT = 19132;

/** 'native' on Windows/Linux (a real BDS binary exists), 'container' on macOS. */
function runtimeFor(platform = process.platform) {
  return platform === 'darwin' ? 'container' : 'native';
}

/** Lima's home. Short by necessity — see the UNIX_PATH_MAX note above. */
function limaHome(homedir) {
  return path.join(homedir, LIMA_DIR_NAME);
}

/**
 * Environment for every limactl/nerdctl invocation.
 * LIMA_HOME must be set on each call: the default (`~/.lima`) would be a
 * different, longer path and a different set of VMs.
 */
function limaEnv(homedir, baseEnv = {}) {
  return { ...baseEnv, LIMA_HOME: limaHome(homedir) };
}

/**
 * argv for a nerdctl command inside the VM.
 * `sudo` is not optional — containerd is a system service in this VM.
 */
function nerdctlArgs(args) {
  if (!Array.isArray(args)) throw new TypeError('nerdctlArgs: args must be an array');
  return ['shell', VM_NAME, 'sudo', 'nerdctl', ...args];
}

/**
 * argv for the PERSISTENT stdin pipe into the running server's console.
 *
 * One long-lived `exec -i` shell, not one `exec` per command: spawning a
 * process per command costs a VM round trip each time, and under a macro
 * firing on every chat line that is the difference between instant and
 * visibly laggy.
 *
 * The container image runs BDS under a supervisor that exposes `send-command`,
 * so each line written to this shell's stdin reaches the server console.
 */
function consolePipeArgs() {
  return nerdctlArgs(['exec', '-i', CONTAINER_NAME, 'sh']);
}

/** argv to follow the container's stdout — the container-mode log source. */
function containerLogArgs() {
  return nerdctlArgs(['logs', '-f', '--tail', '200', CONTAINER_NAME]);
}

/**
 * Single-quote a value for the shell inside the container.
 *
 * Container-mode commands pass through `sh`, so a bare interpolation is a
 * command-injection point: a Minecraft command legitimately containing an
 * apostrophe ("say don't") would otherwise close the quote and let the rest of
 * the line run as shell. POSIX has no escape inside single quotes, so the
 * quote is closed, an escaped quote is emitted, and the quote is reopened.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * One line for the persistent console shell.
 * The command must already be newline-free — `console-bridge.buildCommand`
 * enforces that, because a newline here would be a second shell command.
 */
function sendCommandLine(command) {
  const text = String(command).replace(/\n$/, '');
  if (/[\r\n]/.test(text)) {
    throw new Error('sendCommandLine: command may not contain a newline');
  }
  return `send-command ${shellQuote(text)}\n`;
}

/**
 * Parse `limactl list --json`.
 *
 * The output is JSONL — ONE OBJECT PER LINE, not a JSON array. A single
 * `JSON.parse` of the whole thing works on a machine with exactly one VM and
 * fails on every machine with two, which is precisely the case a clean-machine
 * test never reaches. A malformed line is skipped, not fatal, but the skip is
 * recorded so it can be reported.
 */
function parseVmList(output) {
  const vms = [];
  const skipped = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      vms.push(JSON.parse(text));
    } catch {
      skipped.push(text.slice(0, 120));
    }
  }
  return { vms, skipped };
}

/**
 * Status of our VM as a STRING, never a boolean.
 *
 * "Stopped", "Broken" and "Absent" each need different UI and a different
 * remedy. An entry with no status reports 'Unknown' — defaulting to 'Running'
 * would make the app try to use a dead VM.
 */
function vmStatus(output, name = VM_NAME) {
  const { vms } = parseVmList(output);
  const found = vms.find((vm) => vm && vm.name === name);
  return found ? (found.status || 'Unknown') : 'Absent';
}

/** Only a Running VM is usable. Stopped is not "nearly running". */
function isVmUsable(status) {
  return status === 'Running';
}

/**
 * Resolve limactl: the copy this app ships wins, then PATH, then Homebrew.
 *
 * The bundled binary is preferred so behaviour does not change based on what
 * the user happens to have installed. The Homebrew fallbacks exist because an
 * app launched from Finder inherits a launchd PATH without `/opt/homebrew/bin`,
 * so a working `brew install lima` was reported as "not installed" by anyone
 * who had not started the app from a terminal.
 *
 * A present-but-unrunnable binary must NOT abort the search — it is as useless
 * as a missing one, so the search continues to the next candidate.
 */
function resolveLimactl({ bundledPath, exists, canRun }) {
  if (bundledPath && exists(bundledPath) && canRun(bundledPath)) return bundledPath;
  if (canRun('limactl')) return 'limactl';
  for (const candidate of ['/opt/homebrew/bin/limactl', '/usr/local/bin/limactl']) {
    if (exists(candidate) && canRun(candidate)) return candidate;
  }
  return null;
}

/** The missing-Lima message names BOTH remedies, because either really fixes it. */
function limactlMissingError() {
  return 'Lima is required to run a Bedrock server on macOS and was not found.\n'
    + '  • npm run download:lima   (fetches the copy this app ships with)\n'
    + '  • brew install lima       (uses a system-wide install)\n'
    + 'Which one is right depends on whether you want the app-local copy.';
}

module.exports = {
  VM_NAME,
  LIMA_DIR_NAME,
  CONTAINER_NAME,
  BEDROCK_PORT,
  runtimeFor,
  limaHome,
  limaEnv,
  nerdctlArgs,
  consolePipeArgs,
  containerLogArgs,
  shellQuote,
  sendCommandLine,
  parseVmList,
  vmStatus,
  isVmUsable,
  resolveLimactl,
  limactlMissingError,
};
