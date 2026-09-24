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

const { nerdctlArgs } = require('../sdk/logic/lima');

const VM_NAME = 'mc';
const LIMA_DIR_NAME = '.mc-lima';
const CONTAINER_NAME = 'mc-bedrock';
/** Bedrock's default port. UDP — RakNet, not TCP. */
const BEDROCK_PORT = 19132;

/** 'native' on Windows/Linux (a real BDS binary exists), 'container' on macOS. */
function runtimeFor(platform = process.platform) {
  return platform === 'darwin' ? 'container' : 'native';
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
  return nerdctlArgs(VM_NAME, ['exec', '-i', CONTAINER_NAME, 'sh']);
}

/** argv to follow the container's stdout — the container-mode log source. */
function containerLogArgs() {
  return nerdctlArgs(VM_NAME, ['logs', '-f', '--tail', '200', CONTAINER_NAME]);
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

module.exports = {
  VM_NAME,
  LIMA_DIR_NAME,
  CONTAINER_NAME,
  BEDROCK_PORT,
  runtimeFor,
  nerdctlArgs,
  consolePipeArgs,
  containerLogArgs,
  shellQuote,
  sendCommandLine,
};
