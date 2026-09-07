'use strict';
//
// Hexstack Mentat MCBES — main process.
//
// Runs a Bedrock Dedicated Server locally with a GUI: natively on Windows and
// Linux, and inside a Lima-hosted Linux container on macOS (Mojang ships no
// macOS BDS build — that gap is the reason this app exists).
//
// Rebuilt from design notes after the 2026-04 source was lost; see CLAUDE.md
// for what is reconstructed and what is verified.
//
// EDIT THIS FILE, not electron-main.bundle.js — the bundle is esbuild output.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

const RT = require('./lib/runtime');
const BDS = require('./lib/bds');
const CB = require('./lib/console-bridge');
const MACROS = require('./lib/macros');
const BRIDGE = require('./lib/bridge-protocol');
const CF = require('./lib/cloudflared');
const { memoize } = require('./lib/ttl-cache');
const { quiet, attempt } = require('./lib/failsafe');
const { resolveDataDir } = require('./sdk/utils/data-dir');
const { setupAutoUpdate } = require('./sdk/logic/auto-update');

const APP_NAME = 'ai-mentat-minecraft';
const MCP_SERVER_NAME = 'minecraft';

// ─── Persistent storage layout ────────────────────────────────────────────
//
//   <dataDir>/
//     bds/                     server.properties, worlds, the BDS binary
//     macros/                  *.macro documents (MCMacro v2)
//     logs/server.log          rolling console log, survives restarts
//     settings.json            app settings (publicDomain, install flags)
//     bridge-token             0600, the local control-port secret
//
// <dataDir> is the shared family contract from sdk/utils/data-dir.

const dataDir = resolveDataDir(APP_NAME);
const serverDir = path.join(dataDir, 'bds');
const macrosDir = path.join(dataDir, 'macros');
const logsDir = path.join(dataDir, 'logs');
const SETTINGS_FILE = path.join(dataDir, 'settings.json');
const SERVER_LOG = path.join(logsDir, 'server.log');
const PROPERTIES_FILE = path.join(serverDir, 'server.properties');

for (const dir of [serverDir, macrosDir, logsDir]) fs.mkdirSync(dir, { recursive: true });

const runtime = RT.runtimeFor();

// ─── Globals ──────────────────────────────────────────────────────────────

let mainWindow;
let serverProcess;      // native mode: BDS itself. container mode: the log follower.
let consolePipe;        // container mode: the persistent `nerdctl exec -i sh`
let bridgeServer;
let tunnelProcess;
let ptyProcess;
let tunnelUrl = null;
let cleanupDone = false;
let serverReady = false;
let stdoutCarry = '';

const roster = new BRIDGE.PlayerRoster();
const events = new BRIDGE.EventBuffer(500);
/** eventName -> [{ macroId, rowId, commands, row }] */
let macroBindings = {};

// The local control port's secret. Generated per install; see
// lib/bridge-protocol.js for why a loopback port still needs one.
const bridgeTokenPath = path.join(dataDir, BRIDGE.TOKEN_FILE);
let bridgeToken = quiet('bridge.readToken', () => fs.readFileSync(bridgeTokenPath, 'utf8').trim(), null);
if (!bridgeToken) {
  bridgeToken = BRIDGE.generateToken();
  attempt('bridge.writeToken', () => fs.writeFileSync(bridgeTokenPath, bridgeToken, { mode: 0o600 }));
}

// ─── Settings ─────────────────────────────────────────────────────────────

function loadSettings() {
  // An absent settings.json is the normal first-run state, not a failure --
  // recording it on every status poll floods the bounded failsafe buffer and
  // buries the errors that do matter. Only a real read/parse error is recorded.
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  return quiet('settings.read', () => JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')), {});
}

function saveSettings(data) {
  const merged = { ...loadSettings(), ...data };
  attempt('settings.write', () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2)));
  return merged;
}

function serverPort() {
  const props = readProperties();
  const port = Number(props['server-port']);
  return Number.isInteger(port) && port > 0 ? port : RT.BEDROCK_PORT;
}

// ─── Environment and process helpers ──────────────────────────────────────

function shellEnv() {
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const sep = isWin ? ';' : ':';
  const extra = [path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin')];
  if (isWin) {
    extra.push(
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(home, 'AppData', 'Local', 'Programs', 'claude-code'),
    );
  } else {
    extra.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  const base = process.env.PATH || (isWin ? '' : '/usr/bin:/bin');
  return {
    ...process.env,
    ...RT.limaEnv(home),
    PATH: base ? extra.join(sep) + sep + base : extra.join(sep),
  };
}

/** Run a binary with an argv ARRAY — never a composed command string. */
function run(bin, args, opts = {}) {
  return execFileSync(bin, args, { encoding: 'utf8', ...opts, env: { ...shellEnv(), ...opts.env } });
}

function tryRun(op, bin, args, opts = {}) {
  return quiet(op, () => run(bin, args, opts), null);
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ─── Lima (macOS only) ────────────────────────────────────────────────────

function bundledLimactl() {
  const base = app.isPackaged ? process.resourcesPath : __dirname;
  const name = process.platform === 'win32' ? 'limactl.exe' : 'limactl';
  return path.join(base, 'lima-bin', 'bin', name);
}

function limactl() {
  return RT.resolveLimactl({
    bundledPath: bundledLimactl(),
    exists: (p) => fs.existsSync(p),
    canRun: (p) => tryRun('lima.canRun', p, ['--version'], { stdio: 'pipe', timeout: 5000 }) !== null,
  });
}

const PROBE_TTL_MS = 30000;

/**
 * VM status, cached. The uncached form blocked the main process on every
 * status poll -- with a Broken VM each probe ran to its 20s timeout and the
 * window stopped responding altogether. Invalidated by any action that can
 * change the answer.
 */
const vmStatus = memoize(() => {
  const bin = limactl();
  if (!bin) return 'Absent';
  const out = tryRun('lima.list', bin, ['list', '--json'], { stdio: 'pipe', timeout: 15000 });
  return out === null ? 'Unknown' : RT.vmStatus(out);
}, PROBE_TTL_MS);

/** Bring the VM up, creating it on first run. Slow — the GUI reports progress. */
async function ensureVm() {
  const bin = limactl();
  if (!bin) return { ok: false, error: RT.limactlMissingError() };

  const status = vmStatus();
  if (RT.isVmUsable(status)) return { ok: true };

  try {
    if (status === 'Absent') {
      send('server:log', `[mentat] creating the "${RT.VM_NAME}" VM (first run, this takes a few minutes)\n`);
      fs.mkdirSync(RT.limaHome(os.homedir()), { recursive: true });
      run(bin, ['start', '--name', RT.VM_NAME, '--vm-type', 'vz', '--tty=false',
        `--mount-writable`, `--mount=${dataDir}:w`], { timeout: 900000, stdio: 'pipe' });
    } else {
      send('server:log', `[mentat] starting the "${RT.VM_NAME}" VM (was ${status})\n`);
      run(bin, ['start', RT.VM_NAME, '--tty=false'], { timeout: 600000, stdio: 'pipe' });
    }
  } catch (e) {
    return { ok: false, error: (e.stderr && e.stderr.toString().trim()) || e.message };
  }
  const after = vmStatus();
  return RT.isVmUsable(after) ? { ok: true } : { ok: false, error: `VM is ${after} after start` };
}

// ─── Console bridge ───────────────────────────────────────────────────────
//
// Commands go to the server the way an operator's do: BDS's stdin. Native mode
// writes to the child's own stdin; container mode writes to a persistent
// `nerdctl exec -i sh` whose lines reach the container's console helper.
//
// The alternative, mcpews over WebSocket, was rejected: it needs a player to
// type `/wsserver` in-game every session and authenticates as a player, so it
// does not work in offline mode at all. bedrock-protocol was rejected too — it
// requires native C++ compilation on the user's machine.

const logStream = fs.createWriteStream(SERVER_LOG, { flags: 'a' });

function ingestStdout(chunk) {
  attempt('log.write', () => logStream.write(chunk));
  send('server:log', chunk.toString());

  const { events: parsed, remainder } = CB.parseChunk(chunk, stdoutCarry);
  stdoutCarry = remainder;
  for (const event of parsed) {
    if (event.event === 'ServerReady') serverReady = true;
    if (event.event === 'ServerStopping') serverReady = false;
    roster.apply(event);
    events.push(event);
    send('server:event', event);
    runMacrosFor(event);
  }
}

/**
 * Send one command to the running server.
 * @returns {{success: boolean, error?: string}}
 */
function sendCommand(command) {
  let line;
  try {
    line = CB.buildCommand(command);
  } catch (e) {
    return { success: false, error: e.message };
  }

  if (runtime === 'container') {
    if (!consolePipe || consolePipe.killed) return { success: false, error: 'server console is not attached' };
    try {
      consolePipe.stdin.write(RT.sendCommandLine(line));
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  if (!serverProcess || serverProcess.killed) return { success: false, error: 'server is not running' };
  try {
    serverProcess.stdin.write(line);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Macro engine ─────────────────────────────────────────────────────────

function macroFiles() {
  return quiet('macros.list', () => fs.readdirSync(macrosDir).filter((f) => f.endsWith('.macro')), []);
}

/**
 * Recompile every enabled macro into per-event command lists.
 *
 * Rows that cannot fire on this transport are collected and reported to the
 * GUI rather than dropped — a macro that silently never runs is the worst
 * possible outcome for the person who built it.
 */
function reloadMacros() {
  const enabled = new Set(loadSettings().enabledMacros || []);
  const bindings = {};
  const report = [];

  for (const file of macroFiles()) {
    const text = quiet('macros.read', () => fs.readFileSync(path.join(macrosDir, file), 'utf8'), null);
    if (text === null) continue;
    const { ok, macro, errors } = MACROS.parseMacro(text);
    if (!ok) {
      report.push({ file, name: null, active: false, errors, skipped: [] });
      continue;
    }
    const active = enabled.has(macro.id);
    const { byEvent, skipped } = MACROS.compileMacro(macro);
    report.push({
      file,
      id: macro.id,
      name: macro.name,
      active,
      errors: [],
      skipped,
      events: Object.keys(byEvent),
    });
    if (!active) continue;
    for (const [event, rows] of Object.entries(byEvent)) {
      if (!bindings[event]) bindings[event] = [];
      for (const compiled of rows) {
        const row = (macro.rows || []).find((r) => r.id === compiled.rowId);
        bindings[event].push({ macroId: macro.id, rowId: compiled.rowId, commands: compiled.commands, row });
      }
    }
  }

  macroBindings = bindings;
  return report;
}

function runMacrosFor(event) {
  const bound = macroBindings[event.event];
  if (!bound || bound.length === 0) return;
  for (const binding of bound) {
    if (binding.row && !MACROS.conditionsMet(binding.row, event)) continue;
    for (const command of binding.commands) {
      const result = sendCommand(MACROS.interpolate(command, event));
      if (!result.success) {
        send('server:log', `[mentat] macro ${binding.macroId} row ${binding.rowId}: ${result.error}\n`);
        break;
      }
    }
  }
}

// ─── server.properties ────────────────────────────────────────────────────

function readProperties() {
  // Same reasoning as loadSettings: the file does not exist until the server
  // is installed, and that is expected rather than noteworthy.
  if (!fs.existsSync(PROPERTIES_FILE)) return { ...BDS.DEFAULTS };
  const text = quiet('bds.readProperties', () => fs.readFileSync(PROPERTIES_FILE, 'utf8'), null);
  return text === null ? { ...BDS.DEFAULTS } : BDS.parseServerProperties(text);
}

function writeProperties(changes) {
  const validation = BDS.validateChanges(changes);
  if (!validation.ok) return { success: false, errors: validation.errors };
  const rendered = BDS.renderServerProperties(readProperties(), changes);
  try {
    fs.writeFileSync(PROPERTIES_FILE, rendered);
  } catch (e) {
    return { success: false, errors: [e.message] };
  }
  return { success: true };
}

// ─── Server lifecycle ─────────────────────────────────────────────────────

function nativeBinary() {
  return path.join(serverDir, process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server');
}

/** Cached for the same reason as vmStatus -- see PROBE_TTL_MS. */
const isServerInstalled = memoize(() => {
  if (runtime === 'native') return fs.existsSync(nativeBinary());
  // Asking a broken or stopped VM about its images cannot succeed, and costs
  // a full 20s timeout to find out. Check the VM first.
  if (!RT.isVmUsable(vmStatus())) return false;
  const out = tryRun('container.images', limactl() || 'limactl',
    RT.nerdctlArgs(['images', '--format', '{{.Repository}}']), { stdio: 'pipe', timeout: 20000 });
  return typeof out === 'string' && out.includes(BDS.CONTAINER_IMAGE);
}, PROBE_TTL_MS);

/** Drop cached probe answers after an action that can change them. */
function invalidateProbes() {
  vmStatus.invalidate();
  isServerInstalled.invalidate();
}

async function startNative() {
  if (!fs.existsSync(nativeBinary())) {
    return { success: false, error: 'Bedrock server is not installed yet — run Install first.' };
  }
  if (!fs.existsSync(PROPERTIES_FILE)) writeProperties({});

  serverProcess = spawn(nativeBinary(), [], {
    cwd: serverDir,
    env: { ...shellEnv(), LD_LIBRARY_PATH: serverDir },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  serverProcess.stdout.on('data', ingestStdout);
  serverProcess.stderr.on('data', ingestStdout);
  serverProcess.on('exit', (code) => {
    send('server:log', `\n[mentat] server exited with code ${code}\n`);
    serverReady = false;
    roster.clear();
    serverProcess = null;
    send('server:stopped', { code });
  });
  return { success: true };
}

async function startContainer() {
  const vm = await ensureVm();
  if (!vm.ok) return { success: false, error: vm.error };
  const bin = limactl();
  const port = serverPort();

  // A stopped container from a previous session is restarted rather than
  // recreated: recreating would discard nothing (the world is on a volume) but
  // it does discard the container's own logs, which are the only record of
  // what happened last session.
  const existing = tryRun('container.inspectState', bin,
    RT.nerdctlArgs(['ps', '-a', '--filter', `name=${RT.CONTAINER_NAME}`, '--format', '{{.Status}}']),
    { stdio: 'pipe', timeout: 20000 });

  try {
    if (existing && existing.trim()) {
      if (!/^up/i.test(existing.trim())) {
        run(bin, RT.nerdctlArgs(['start', RT.CONTAINER_NAME]), { timeout: 60000, stdio: 'pipe' });
      }
    } else {
      run(bin, RT.nerdctlArgs(['pull', BDS.CONTAINER_IMAGE]), { timeout: 900000, stdio: 'pipe' });
      run(bin, RT.nerdctlArgs(BDS.containerCreateArgs({ dataDir: serverDir, port })),
        { timeout: 120000, stdio: 'pipe' });
    }
  } catch (e) {
    return { success: false, error: (e.stderr && e.stderr.toString().trim()) || e.message };
  }

  // Persistent console pipe — one long-lived exec, not one per command.
  consolePipe = spawn(bin, RT.consolePipeArgs(), { env: shellEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  consolePipe.on('error', (e) => send('server:log', `[mentat] console pipe: ${e.message}\n`));
  consolePipe.on('exit', () => { consolePipe = null; });

  // Container mode reads the server's output from the container log.
  serverProcess = spawn(bin, RT.containerLogArgs(), { env: shellEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  serverProcess.stdout.on('data', ingestStdout);
  serverProcess.stderr.on('data', ingestStdout);
  serverProcess.on('exit', () => { serverProcess = null; });
  return { success: true };
}

async function startServer() {
  if (serverProcess) return { success: true };
  send('server:log', `[mentat] starting Bedrock server (${runtime} runtime)\n`);
  const result = runtime === 'container' ? await startContainer() : await startNative();
  if (result.success) reloadMacros();
  return result;
}

async function stopServer() {
  // `stop` through the console is the only clean shutdown: BDS flushes the
  // world on it. Killing the process risks a corrupt level.
  if (serverReady) {
    sendCommand('stop');
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (runtime === 'container') {
    const bin = limactl();
    if (bin) tryRun('container.stop', bin, RT.nerdctlArgs(['stop', RT.CONTAINER_NAME]), { timeout: 60000, stdio: 'pipe' });
    if (consolePipe) {
      attempt('console.kill', () => consolePipe.kill());
      consolePipe = null;
    }
  }
  if (serverProcess) {
    killProcess(serverProcess, 'server');
    serverProcess = null;
  }
  serverReady = false;
  roster.clear();
  return { success: true };
}

// ─── Local control port ───────────────────────────────────────────────────
//
// `bedrock-mcp-server.mjs` (registered with Claude Code) and the macro engine
// both drive the server through this. Bound to loopback AND token-guarded —
// see lib/bridge-protocol.js for why loopback alone is not enough.

function handleBridgeRequest(request) {
  switch (request.op) {
    case 'status':
      return { runtime, ready: serverReady, running: !!serverProcess, port: serverPort(), players: roster.count };
    case 'players':
      return { players: roster.list() };
    case 'events':
      return { events: events.recent(Number(request.count) || 50) };
    case 'say':
      return sendCommand(`say ${request.message}`);
    case 'command':
      return sendCommand(request.command);
    default:
      // validateRequest already rejected anything else.
      return { success: false, error: 'unhandled op' };
  }
}

function startBridgeServer() {
  const port = Number(loadSettings().bridgePort) || BRIDGE.DEFAULT_PORT;
  bridgeServer = http.createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const auth = BRIDGE.authorize(req.headers, bridgeToken);
    if (!auth.ok) return reply(auth.status, { error: auth.error });
    if (req.method !== 'POST') return reply(405, { error: 'POST only' });

    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      body += chunk;
      // A control request is tiny; refusing an oversized one keeps a local
      // process from growing this buffer without limit.
      if (body.length > 64 * 1024) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      const validated = BRIDGE.validateRequest(body);
      if (!validated.ok) return reply(400, { error: validated.error });
      try {
        reply(200, handleBridgeRequest(validated.request));
      } catch (e) {
        reply(500, { error: e.message });
      }
    });
  });

  bridgeServer.on('error', (e) => {
    // A port clash must be visible: the MCP server would otherwise fail with
    // an opaque connection error.
    send('server:log', `[mentat] control port ${port} unavailable: ${e.message}\n`);
  });
  bridgeServer.listen(port, '127.0.0.1', () => {
    console.log(`Control port listening on 127.0.0.1:${port}`);
  });
}

// ─── Claude Code MCP ──────────────────────────────────────────────────────

const MENTAT_COMMAND = `---
name: mentat-mcbes
description: Run Minecraft Bedrock server tasks through the Mentat MCBES bridge
allowed-tools:
  - mcp__minecraft__*
---

You are connected to a local Minecraft Bedrock Dedicated Server through the
Mentat MCBES control bridge.

Available through the MCP server: run a console command, broadcast a message,
list online players, and read recent server events (join, leave, chat).

Only those three event types are observable — the bridge reads the server's
console output, so block, movement and item events do not exist here.

$ARGUMENTS
`;

function mcpServerPath() {
  const base = app.isPackaged ? process.resourcesPath : __dirname;
  return path.join(base, 'bedrock-mcp-server.mjs');
}

ipcMain.handle('mcp:status', async () => {
  const settings = loadSettings();
  const claudeJson = path.join(os.homedir(), '.claude.json');
  let registered = false;
  const raw = quiet('mcp.readClaudeJson', () => fs.readFileSync(claudeJson, 'utf8'), null);
  if (raw) {
    const data = quiet('mcp.parseClaudeJson', () => JSON.parse(raw), null);
    if (data) {
      registered = !!(data.mcpServers && data.mcpServers[MCP_SERVER_NAME]);
      if (!registered && data.projects) {
        for (const project of Object.values(data.projects)) {
          if (project && project.mcpServers && project.mcpServers[MCP_SERVER_NAME]) { registered = true; break; }
        }
      }
    }
  }
  return { mcpInstalled: !!settings.mcpInstalled || registered };
});

ipcMain.handle('mcp:install', async () => {
  const home = os.homedir();
  const port = Number(loadSettings().bridgePort) || BRIDGE.DEFAULT_PORT;
  for (const scope of ['user', 'local', 'project']) {
    tryRun(`mcp.remove.${scope}`, 'claude', ['mcp', 'remove', MCP_SERVER_NAME, '-s', scope],
      { timeout: 15000, stdio: 'pipe', cwd: home });
  }
  try {
    // The token goes in as an env var, never on the command line — argv is
    // world-readable in the process table.
    run('claude', [
      'mcp', 'add', MCP_SERVER_NAME, '-s', 'user',
      '-e', `${BRIDGE.TOKEN_ENV}=${bridgeToken}`,
      '--', 'node', mcpServerPath(), '--port', String(port),
    ], { timeout: 30000, cwd: home });
    attempt('mcp.writeCommand', () => {
      const commandsDir = path.join(home, '.claude', 'commands');
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, 'mentat-mcbes.md'), MENTAT_COMMAND);
    });
    saveSettings({ mcpInstalled: true });
    return { success: true };
  } catch (e) {
    return { success: false, error: (e.stderr && e.stderr.toString().trim()) || e.message };
  }
});

ipcMain.handle('mcp:uninstall', async () => {
  const home = os.homedir();
  for (const scope of ['user', 'local', 'project']) {
    tryRun(`mcp.remove.${scope}`, 'claude', ['mcp', 'remove', MCP_SERVER_NAME, '-s', scope],
      { timeout: 15000, stdio: 'pipe', cwd: home });
  }
  saveSettings({ mcpInstalled: false });
  return { success: true };
});

// ─── IPC: server ──────────────────────────────────────────────────────────

ipcMain.handle('server:status', async () => ({
  runtime,
  running: !!serverProcess,
  ready: serverReady,
  installed: isServerInstalled(),
  vmStatus: runtime === 'container' ? vmStatus() : null,
  players: roster.list(),
  port: serverPort(),
  publicDomain: loadSettings().publicDomain || null,
  dataDir,
  properties: readProperties(),
}));

ipcMain.handle('server:start', async () => {
  const r = await startServer();
  invalidateProbes();
  return r;
});
ipcMain.handle('server:stop', async () => {
  const r = await stopServer();
  invalidateProbes();
  return r;
});
ipcMain.handle('server:restart', async () => {
  await stopServer();
  const r = await startServer();
  invalidateProbes();
  return r;
});
ipcMain.handle('server:command', async (_, command) => sendCommand(command));
ipcMain.handle('server:save-properties', async (_, changes) => {
  if (!changes || typeof changes !== 'object') return { success: false, errors: ['no changes given'] };
  const result = writeProperties(changes);
  // server.properties is read once at boot, so a save only takes effect on a
  // restart. Saying so beats a silently ignored change.
  return { ...result, restartNeeded: result.success && !!serverProcess };
});

ipcMain.handle('server:install', async () => {
  if (runtime === 'container') {
    const vm = await ensureVm();
    if (!vm.ok) return { success: false, error: vm.error };
    try {
      run(limactl(), RT.nerdctlArgs(['pull', BDS.CONTAINER_IMAGE]), { timeout: 900000, stdio: 'pipe' });
      invalidateProbes();
      return { success: true };
    } catch (e) {
      return { success: false, error: (e.stderr && e.stderr.toString().trim()) || e.message };
    }
  }
  return {
    success: false,
    // Mojang requires accepting the EULA on their download page, so the app
    // cannot fetch BDS unattended without misrepresenting that consent.
    error: 'Download the Bedrock Dedicated Server from minecraft.net and unzip it into '
      + `${serverDir} — Mojang requires you to accept their EULA on the download page.`,
    openPath: serverDir,
  };
});

// ─── IPC: macros ──────────────────────────────────────────────────────────

ipcMain.handle('macros:list', async () => ({ macros: reloadMacros(), enabled: loadSettings().enabledMacros || [] }));

ipcMain.handle('macros:read', async (_, file) => {
  const safe = path.basename(String(file || ''));
  if (!safe.endsWith('.macro')) return { success: false, error: 'not a macro file' };
  const text = quiet('macros.read', () => fs.readFileSync(path.join(macrosDir, safe), 'utf8'), null);
  if (text === null) return { success: false, error: 'macro not found' };
  return { success: true, text };
});

ipcMain.handle('macros:save', async (_, file, text) => {
  // basename() is the trust boundary: a renderer-supplied name lands in a
  // filesystem path, so `../../.claude/settings.json` must not escape.
  const safe = path.basename(String(file || ''));
  if (!safe.endsWith('.macro')) return { success: false, error: 'macro files must end in .macro' };
  const parsed = MACROS.parseMacro(text);
  if (!parsed.ok) return { success: false, error: parsed.errors.join('; ') };
  try {
    fs.writeFileSync(path.join(macrosDir, safe), typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  } catch (e) {
    return { success: false, error: e.message };
  }
  return { success: true, report: reloadMacros() };
});

ipcMain.handle('macros:delete', async (_, file) => {
  const safe = path.basename(String(file || ''));
  if (!safe.endsWith('.macro')) return { success: false, error: 'not a macro file' };
  try {
    fs.rmSync(path.join(macrosDir, safe), { force: true });
  } catch (e) {
    return { success: false, error: e.message };
  }
  return { success: true, report: reloadMacros() };
});

ipcMain.handle('macros:set-enabled', async (_, id, enabled) => {
  if (typeof id !== 'string' || !id) return { success: false, error: 'no macro id' };
  const current = new Set(loadSettings().enabledMacros || []);
  if (enabled) current.add(id);
  else current.delete(id);
  saveSettings({ enabledMacros: [...current] });
  return { success: true, report: reloadMacros() };
});

ipcMain.handle('macros:open-folder', async () => {
  await shell.openPath(macrosDir);
  return { success: true };
});

// ─── IPC: shell, tunnel, terminal ─────────────────────────────────────────

ipcMain.handle('shell:open-external', async (_, url) => {
  if (typeof url !== 'string') return { success: false };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { success: false };
  }
  if (parsed.protocol !== 'https:') return { success: false };
  await shell.openExternal(parsed.toString());
  return { success: true };
});

ipcMain.handle('shell:open-data', async () => {
  await shell.openPath(dataDir);
  return { success: true };
});

const cloudflaredConfigPath = () => path.join(os.homedir(), '.cloudflared', 'config.yml');

function readTunnelConfig() {
  const text = quiet('cloudflared.readConfig', () => fs.readFileSync(cloudflaredConfigPath(), 'utf8'), null);
  if (text === null) return CF.parseTunnelConfig('', serverPort());
  return quiet('cloudflared.parseConfig', () => CF.parseTunnelConfig(text, serverPort()),
    CF.parseTunnelConfig('', serverPort()));
}

ipcMain.handle('cloudflared:check', async () => {
  if (tryRun('cloudflared.versionNpx', 'npx', ['cloudflared', '--version'], { timeout: 15000, stdio: 'pipe' }) !== null) {
    return { installed: true };
  }
  return { installed: tryRun('cloudflared.version', 'cloudflared', ['--version'], { timeout: 5000, stdio: 'pipe' }) !== null };
});

ipcMain.handle('cloudflared:install', async () => {
  try {
    run('npx', ['bun', 'add', '-g', 'cloudflared'], { timeout: 60000 });
    return { success: true };
  } catch (e) {
    return { success: false, error: (e.stderr && e.stderr.toString().trim()) || e.message };
  }
});

ipcMain.handle('cloudflared:auth-status', async () => ({
  authenticated: fs.existsSync(path.join(os.homedir(), '.cloudflared', 'cert.pem')),
}));

ipcMain.handle('cloudflared:login', async () => new Promise((resolve) => {
  let proc;
  try {
    proc = spawn('cloudflared', ['tunnel', 'login'], { stdio: 'pipe', detached: true, env: shellEnv() });
  } catch (e) {
    return resolve({ success: false, error: e.message });
  }
  let output = '';
  const collect = (d) => { output += d.toString(); };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  proc.on('error', (e) => resolve({ success: false, error: e.message }));
  const timer = setTimeout(() => {
    attempt('cloudflared.login.killTimeout', () => proc.kill());
    resolve({ success: false, error: 'Login timed out' });
  }, 300000);
  proc.on('exit', (code) => {
    clearTimeout(timer);
    resolve(code === 0 ? { success: true } : { success: false, error: output.trim() || `Exit code ${code}` });
  });
}));

ipcMain.handle('cloudflared:tunnel-status', async () => {
  const cfg = readTunnelConfig();
  return { configured: cfg.configured, tunnelName: cfg.tunnel, hostname: cfg.hostname };
});

ipcMain.handle('cloudflared:setup-tunnel', async (_, domain) => {
  const hostname = typeof domain === 'string' ? domain.trim() : '';
  if (!hostname) return { success: false, error: 'Domain is required' };
  if (!CF.isValidHostname(hostname)) {
    return { success: false, error: `"${hostname}" is not a valid hostname — use something like mc.example.com` };
  }
  try {
    const tunnelName = 'mentat-mc';
    const cfDir = path.join(os.homedir(), '.cloudflared');
    let tunnelId = null;

    const list = tryRun('cloudflared.list', 'cloudflared', ['tunnel', 'list', '-o', 'json'], { timeout: 15000, stdio: 'pipe' });
    if (list) {
      const tunnels = quiet('cloudflared.parseList', () => JSON.parse(list), []);
      const existing = Array.isArray(tunnels) ? tunnels.find((t) => t && t.name === tunnelName) : null;
      if (existing) {
        if (fs.existsSync(path.join(cfDir, `${existing.id}.json`))) tunnelId = existing.id;
        else tryRun('cloudflared.delete', 'cloudflared', ['tunnel', 'delete', '-f', tunnelName], { timeout: 15000, stdio: 'pipe' });
      }
    }
    if (!tunnelId) {
      const out = run('cloudflared', ['tunnel', 'create', tunnelName], { timeout: 15000, stdio: 'pipe' });
      tunnelId = CF.parseTunnelId(out);
      if (!tunnelId) return { success: false, error: `Failed to parse tunnel ID from: ${out}` };
    }

    fs.mkdirSync(cfDir, { recursive: true });
    fs.writeFileSync(cloudflaredConfigPath(), CF.renderTunnelConfig({
      tunnelId,
      credentialsFile: path.join(cfDir, `${tunnelId}.json`),
      hostname,
      port: serverPort(),
      scheme: 'udp',
    }));

    try {
      run('cloudflared', ['tunnel', 'route', 'dns', '--overwrite-dns', tunnelId, hostname], { timeout: 15000, stdio: 'pipe' });
    } catch (e) {
      const err = (e.stderr && e.stderr.toString()) || '';
      if (!err.includes('already exists')) return { success: false, error: `DNS route failed: ${err.trim() || e.message}` };
    }

    saveSettings({ publicDomain: hostname });
    return {
      success: true,
      tunnelId,
      hostname,
      // Say the limitation out loud rather than implying public play works.
      note: 'Bedrock is UDP. Cloudflare carries UDP over a tunnel for private '
        + 'access only, so players must be on WARP (or Cloudflare Spectrum). For '
        + 'open public play, forward the port on your router instead.',
    };
  } catch (e) {
    return { success: false, error: (e.stderr && e.stderr.toString().trim()) || e.message };
  }
});

ipcMain.handle('tunnel:start', async () => {
  if (tunnelProcess && !tunnelProcess.killed) return { success: true, url: tunnelUrl };
  const { hostname } = readTunnelConfig();
  if (!hostname) return { success: false, error: 'No tunnel configured — complete setup first' };
  try {
    tunnelProcess = spawn('cloudflared', ['tunnel', 'run'], { stdio: 'pipe', detached: true, env: shellEnv() });
    tunnelUrl = null;
    let connected = false;
    const onOutput = (data) => {
      const text = data.toString();
      send('tunnel:log', text);
      if (!connected && CF.isTunnelConnectedLine(text)) {
        connected = true;
        tunnelUrl = hostname;
        send('tunnel:url-update', hostname);
      }
    };
    tunnelProcess.stdout.on('data', onOutput);
    tunnelProcess.stderr.on('data', onOutput);
    tunnelProcess.on('exit', (code) => {
      send('tunnel:log', `\n[cloudflared exited with code ${code}]\n`);
      tunnelProcess = null;
      tunnelUrl = null;
    });
    for (let i = 0; i < 20 && !tunnelUrl; i++) await new Promise((r) => setTimeout(r, 1000));
    if (!tunnelUrl) return { success: false, error: 'Named tunnel failed to connect' };
    return { success: true, url: tunnelUrl };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('tunnel:stop', async () => {
  if (tunnelProcess && !tunnelProcess.killed) {
    tunnelProcess.kill('SIGTERM');
    tunnelProcess = null;
    tunnelUrl = null;
  }
  return { success: true };
});

ipcMain.handle('tunnel:status', async () => ({
  running: !!(tunnelProcess && !tunnelProcess.killed),
  url: tunnelUrl,
}));

ipcMain.handle('pty:spawn', async (_, cols, rows, skipPerms) => {
  try {
    if (ptyProcess) {
      attempt('pty.killPrevious', () => ptyProcess.kill());
      ptyProcess = null;
    }
    const home = os.homedir();
    const env = { ...shellEnv(), TERM: 'xterm-256color', COLUMNS: String(cols || 80), LINES: String(rows || 24) };
    const args = skipPerms ? ['--dangerously-skip-permissions', '/mentat-mcbes'] : ['/mentat-mcbes'];

    if (process.platform === 'win32') {
      ptyProcess = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: home, env });
    } else {
      const localClaude = path.join(home, '.local', 'bin', 'claude');
      const bin = fs.existsSync(localClaude) ? localClaude : 'claude';
      // asarUnpack'd: python3 cannot execute a script inside the archive.
      let helperPath = path.join(__dirname, 'pty-helper.py');
      if (app.isPackaged || __dirname.includes('app.asar')) {
        helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
      }
      ptyProcess = spawn('python3', [helperPath, bin, ...args], { stdio: ['pipe', 'pipe', 'pipe'], cwd: home, env });
      ptyProcess.on('error', (e) => console.error('PTY spawn error:', e.message));
    }
    const relay = (data) => send('pty:data', data.toString());
    ptyProcess.stdout.on('data', relay);
    ptyProcess.stderr.on('data', relay);
    ptyProcess.on('exit', () => {
      send('pty:exit');
      ptyProcess = null;
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.on('pty:write', (_, data) => {
  if (ptyProcess && !ptyProcess.killed && typeof data === 'string') ptyProcess.stdin.write(data);
});
ipcMain.on('pty:resize', () => {
  if (ptyProcess && ptyProcess.pid && process.platform !== 'win32') {
    attempt('pty.resize', () => process.kill(ptyProcess.pid, 'SIGWINCH'));
  }
});
ipcMain.on('pty:kill', () => {
  if (!ptyProcess) return;
  if (process.platform !== 'win32') attempt('pty.killGroup', () => process.kill(-ptyProcess.pid, 'SIGTERM'));
  attempt('pty.kill', () => ptyProcess.kill());
  ptyProcess = null;
});

// ─── Window and shutdown ──────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    title: 'Minecraft Mentat',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });
  mainWindow.on('closed', () => cleanup());
  mainWindow.webContents.on('did-fail-load', (_, code, desc) => console.error('Load failed:', desc));
  mainWindow.loadFile(path.join(__dirname, 'app.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!app.isPackaged) mainWindow.webContents.openDevTools();
    setupAutoUpdate(mainWindow);
  });
}

function killProcess(proc, name) {
  if (!proc || proc.killed) return;
  attempt(`kill.${name}.term`, () => {
    if (process.platform === 'win32') run('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-proc.pid, 'SIGTERM');
  });
  setTimeout(() => {
    try {
      if (!proc.killed) {
        if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL');
        proc.kill('SIGKILL');
      }
    } catch { /* already gone */ }
  }, 3000);
}

function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  console.log('Cleaning up...');

  // The container is stopped; the VM is deliberately LEFT RUNNING. Booting a
  // VM takes minutes and booting a container takes seconds, so the next launch
  // should not pay the VM cost again.
  if (serverReady) attempt('server.stopCommand', () => sendCommand('stop'));
  if (runtime === 'container') {
    const bin = limactl();
    if (bin) tryRun('container.stop', bin, RT.nerdctlArgs(['stop', RT.CONTAINER_NAME]), { timeout: 30000, stdio: 'pipe' });
  }
  killProcess(serverProcess, 'server');
  killProcess(tunnelProcess, 'tunnel');
  if (consolePipe) attempt('console.kill', () => consolePipe.kill());
  if (ptyProcess) attempt('pty.kill', () => ptyProcess.kill());
  if (bridgeServer) attempt('bridge.close', () => bridgeServer.close());
  attempt('log.close', () => logStream.end());
  setTimeout(() => app.quit(), 1000);
}

app.setName('Minecraft Mentat');

app.whenReady().then(() => {
  createWindow();
  startBridgeServer();
  reloadMacros();
});

app.on('window-all-closed', () => cleanup());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('before-quit', () => cleanup());
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', (e) => {
  // EPIPE and ERR_STREAM_DESTROYED happen whenever a child exits before a
  // write completes — the console pipe and the PTY both do this routinely.
  // Treating them as fatal used to quit the whole app.
  if (e && (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED')) {
    console.warn('Ignoring harmless stream error:', e.code);
    return;
  }
  console.error('Uncaught:', e);
  cleanup();
});
