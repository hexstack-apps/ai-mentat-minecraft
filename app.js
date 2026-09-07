'use strict';
//
// Renderer. Kept in its own file rather than inline so the page's CSP can
// forbid inline script outright, and so no handler needs a global.

const api = window.electronAPI;
const $ = (id) => document.getElementById(id);

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setMsg(id, text, kind = '') {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = `msg${kind ? ` ${kind}` : ''}`;
}

function setDot(id, color) {
  const el = $(id);
  if (el) el.className = `status-dot${color ? ` ${color}` : ''}`;
}

function show(id, visible) {
  const el = $(id);
  if (el) el.style.display = visible ? '' : 'none';
}

// ─── Tabs ─────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-bar button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-bar button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

$('logo-link').addEventListener('click', (e) => {
  e.preventDefault();
  api.openExternal('https://hexstack.app');
});

// ─── Server tab ───────────────────────────────────────────────────────────

const PROPERTY_INPUTS = {
  'server-name': 'prop-server-name',
  'gamemode': 'prop-gamemode',
  'difficulty': 'prop-difficulty',
  'max-players': 'prop-max-players',
  'server-port': 'prop-server-port',
};
const PROPERTY_CHECKS = {
  'allow-cheats': 'prop-allow-cheats',
  'online-mode': 'prop-online-mode',
};

let propertiesLoaded = false;

function renderProperties(properties) {
  // Load once: re-filling on every poll would overwrite what the user is
  // halfway through typing.
  if (propertiesLoaded) return;
  propertiesLoaded = true;
  for (const [key, id] of Object.entries(PROPERTY_INPUTS)) {
    if (properties[key] !== undefined) $(id).value = properties[key];
  }
  for (const [key, id] of Object.entries(PROPERTY_CHECKS)) {
    $(id).checked = String(properties[key]) === 'true';
  }
}

function renderPlayers(players) {
  setText('player-count', String(players.length));
  const list = $('player-list');
  if (players.length === 0) {
    list.textContent = 'Nobody is connected.';
    return;
  }
  list.textContent = '';
  for (const player of players) {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.textContent = player.player;
    list.appendChild(row);
  }
}

async function refreshServer() {
  const status = await api.serverStatus();

  setText('runtime-badge', status.runtime === 'container' ? 'container runtime (Lima)' : 'native runtime');

  if (status.ready) {
    setDot('server-dot', 'green');
    setText('server-desc', `Running and accepting players on UDP ${status.port}.`);
  } else if (status.running) {
    setDot('server-dot', 'amber');
    setText('server-desc', 'Starting…');
  } else if (!status.installed) {
    setDot('server-dot', 'red');
    setText('server-desc', status.runtime === 'container'
      ? 'The server image is not installed yet.'
      : 'The Bedrock server is not installed yet.');
  } else {
    setDot('server-dot', 'red');
    setText('server-desc', 'Stopped.');
  }

  if (status.runtime === 'container' && status.vmStatus && status.vmStatus !== 'Running') {
    setMsg('server-msg', `Lima VM: ${status.vmStatus} — it will be started when you start the server.`, '');
  }

  show('server-start-btn', !status.running);
  show('server-stop-btn', status.running);
  show('server-restart-btn', status.running);
  show('server-install-btn', !status.installed);

  renderPlayers(status.players || []);
  renderProperties(status.properties || {});
}

$('server-start-btn').addEventListener('click', async () => {
  const btn = $('server-start-btn');
  btn.disabled = true;
  setMsg('server-msg', 'Starting…', '');
  const r = await api.serverStart();
  setMsg('server-msg', r.success ? '' : (r.error || 'Failed to start'), r.success ? '' : 'error');
  btn.disabled = false;
  refreshServer();
});

$('server-stop-btn').addEventListener('click', async () => {
  setMsg('server-msg', 'Stopping — sending the console "stop" so the world is flushed…', '');
  await api.serverStop();
  setMsg('server-msg', '', '');
  refreshServer();
});

$('server-restart-btn').addEventListener('click', async () => {
  setMsg('server-msg', 'Restarting…', '');
  const r = await api.serverRestart();
  setMsg('server-msg', r.success ? '' : (r.error || 'Restart failed'), r.success ? '' : 'error');
  refreshServer();
});

$('server-install-btn').addEventListener('click', async () => {
  const btn = $('server-install-btn');
  btn.disabled = true;
  setMsg('server-msg', 'Installing — this pulls a container image and can take a few minutes…', '');
  const r = await api.serverInstall();
  setMsg('server-msg', r.success ? 'Installed.' : (r.error || 'Install failed'), r.success ? 'success' : 'error');
  btn.disabled = false;
  refreshServer();
});

$('open-data-btn').addEventListener('click', () => api.openDataFolder());

const logEl = $('server-log');
api.onServerLog((text) => {
  logEl.textContent += text;
  // Trim the pane: a long session otherwise grows this node without bound.
  if (logEl.textContent.length > 200000) {
    logEl.textContent = logEl.textContent.slice(-150000);
  }
  logEl.scrollTop = logEl.scrollHeight;
});

api.onServerEvent(() => refreshServer());
api.onServerStopped(() => refreshServer());

async function sendConsole() {
  const input = $('console-input');
  const command = input.value.trim();
  if (!command) return;
  const r = await api.serverCommand(command);
  setMsg('console-msg', r.success ? '' : (r.error || 'Failed'), r.success ? '' : 'error');
  if (r.success) input.value = '';
}
$('console-send-btn').addEventListener('click', sendConsole);
$('console-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendConsole();
});

$('props-save-btn').addEventListener('click', async () => {
  const changes = {};
  for (const [key, id] of Object.entries(PROPERTY_INPUTS)) changes[key] = $(id).value.trim();
  for (const [key, id] of Object.entries(PROPERTY_CHECKS)) changes[key] = $(id).checked ? 'true' : 'false';
  const r = await api.saveProperties(changes);
  if (!r.success) {
    setMsg('props-msg', (r.errors || ['Save failed']).join('; '), 'error');
    return;
  }
  setMsg('props-msg', r.restartNeeded
    ? 'Saved — restart the server to apply it.'
    : 'Saved.', 'success');
});

// ─── Macros tab ───────────────────────────────────────────────────────────

function macroCard(entry) {
  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('h3');
  title.textContent = entry.name || entry.file;
  card.appendChild(title);

  if (entry.errors && entry.errors.length) {
    const err = document.createElement('div');
    err.className = 'msg error';
    err.textContent = entry.errors.join('; ');
    card.appendChild(err);
    return card;
  }

  const desc = document.createElement('p');
  desc.className = 'step-desc';
  desc.textContent = (entry.events && entry.events.length)
    ? `Runs on: ${entry.events.join(', ')}`
    : 'No runnable rows.';
  card.appendChild(desc);

  const row = document.createElement('div');
  row.className = 'row';
  const toggle = document.createElement('label');
  toggle.className = 'inline-check';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = !!entry.active;
  check.disabled = !entry.events || entry.events.length === 0;
  check.addEventListener('change', async () => {
    await api.macrosSetEnabled(entry.id, check.checked);
    refreshMacros();
  });
  toggle.appendChild(check);
  toggle.appendChild(document.createTextNode(' Enabled'));
  row.appendChild(toggle);
  card.appendChild(row);

  // Skipped rows are shown, never hidden: a macro that silently never fires is
  // the worst outcome for whoever built it.
  if (entry.skipped && entry.skipped.length) {
    const list = document.createElement('ul');
    list.className = 'skipped-list';
    for (const skip of entry.skipped) {
      const li = document.createElement('li');
      li.textContent = `row ${skip.rowId || '?'}: ${skip.reason}`;
      list.appendChild(li);
    }
    const heading = document.createElement('p');
    heading.className = 'step-desc';
    heading.textContent = 'Rows that will not run:';
    card.appendChild(heading);
    card.appendChild(list);
  }

  return card;
}

async function refreshMacros() {
  const { macros } = await api.macrosList();
  const container = $('macro-cards');
  container.textContent = '';
  if (!macros.length) {
    setMsg('macros-msg', 'No macros yet. Drop a .macro file into the macros folder.', '');
    return;
  }
  setMsg('macros-msg', '', '');
  for (const entry of macros) container.appendChild(macroCard(entry));
}

$('macros-refresh-btn').addEventListener('click', refreshMacros);
$('macros-folder-btn').addEventListener('click', () => api.macrosOpenFolder());

// ─── MCP tab ──────────────────────────────────────────────────────────────

async function refreshMcp() {
  const status = await api.mcpStatus();
  setDot('mcp-dot', status.mcpInstalled ? 'green' : 'red');
  show('mcp-install-btn', !status.mcpInstalled);
  show('mcp-uninstall-btn', status.mcpInstalled);
}

$('mcp-install-btn').addEventListener('click', async () => {
  const btn = $('mcp-install-btn');
  btn.disabled = true;
  setMsg('mcp-msg', 'Registering with Claude Code…', '');
  const r = await api.mcpInstall();
  setMsg('mcp-msg', r.success ? 'Installed — use /mentat-mcbes in Claude Code.' : (r.error || 'Failed'),
    r.success ? 'success' : 'error');
  btn.disabled = false;
  refreshMcp();
});

$('mcp-uninstall-btn').addEventListener('click', async () => {
  await api.mcpUninstall();
  setMsg('mcp-msg', 'Removed.', '');
  refreshMcp();
});

// ─── Embedded terminal ────────────────────────────────────────────────────

let term = null;
let fitAddon = null;

$('terminal-open-btn').addEventListener('click', async () => {
  $('terminal-overlay').classList.add('visible');
  if (!term) {
    term = new window.Terminal({ fontSize: 12, theme: { background: '#0f0f1a' } });
    fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open($('terminal-container'));
    term.onData((data) => api.ptyWrite(data));
    api.onPtyData((data) => term.write(data));
    api.onPtyExit(() => term.write('\r\n[session ended]\r\n'));
  }
  fitAddon.fit();
  const r = await api.ptySpawn(term.cols, term.rows, $('skip-perms').checked);
  if (!r.success) term.write(`\r\nFailed to start Claude Code: ${r.error}\r\n`);
});

$('terminal-close-btn').addEventListener('click', () => {
  $('terminal-overlay').classList.remove('visible');
  api.ptyKill();
});

window.addEventListener('resize', () => {
  if (!term || !fitAddon) return;
  fitAddon.fit();
  api.ptyResize(term.cols, term.rows);
});

// ─── Tunnel tab ───────────────────────────────────────────────────────────

async function refreshTunnel() {
  const { installed } = await api.cloudflaredCheck();
  setDot('cf-dot', installed ? 'green' : 'red');
  // Hide the whole ROW, not just the button: an empty .row still occupies its
  // height and margin, which left a satisfied step as a tall blank card.
  show('cf-install-row', !installed);
  setMsg('cf-msg', installed ? 'cloudflared is installed.' : '', installed ? 'success' : '');
  show('step-auth', installed);
  if (!installed) return;

  const { authenticated } = await api.cloudflaredAuthStatus();
  setDot('auth-dot', authenticated ? 'green' : 'red');
  show('auth-row', !authenticated);
  setMsg('auth-msg', authenticated ? 'Authenticated with Cloudflare.' : '', authenticated ? 'success' : '');
  show('step-setup', authenticated);
  if (!authenticated) return;

  const configured = await api.cloudflaredTunnelStatus();
  setDot('setup-dot', configured.configured ? 'green' : 'red');
  show('step-run', configured.configured);
  if (configured.configured) {
    setText('tunnel-configured-host', `Configured for ${configured.hostname}`);
    $('tunnel-domain').value = configured.hostname;
  }

  const running = await api.tunnelStatus();
  setDot('tunnel-dot', running.running ? 'green' : 'red');
  show('tunnel-start-btn', !running.running);
  show('tunnel-stop-btn', running.running);
}

$('cf-install-btn').addEventListener('click', async () => {
  setMsg('cf-msg', 'Installing cloudflared…', '');
  const r = await api.cloudflaredInstall();
  setMsg('cf-msg', r.success ? 'Installed.' : (r.error || 'Failed'), r.success ? 'success' : 'error');
  refreshTunnel();
});

$('auth-btn').addEventListener('click', async () => {
  setMsg('auth-msg', 'A browser window has opened — approve the domain there.', '');
  const r = await api.cloudflaredLogin();
  setMsg('auth-msg', r.success ? 'Authenticated.' : (r.error || 'Failed'), r.success ? 'success' : 'error');
  refreshTunnel();
});

$('setup-btn').addEventListener('click', async () => {
  const btn = $('setup-btn');
  const domain = $('tunnel-domain').value.trim();
  if (!domain) {
    setMsg('setup-msg', 'Enter a hostname', 'error');
    return;
  }
  btn.disabled = true;
  setMsg('setup-msg', 'Creating the tunnel and DNS route…', '');
  const r = await api.cloudflaredSetupTunnel(domain);
  setMsg('setup-msg', r.success ? `Tunnel created for ${r.hostname}. ${r.note || ''}` : (r.error || 'Failed'),
    r.success ? 'success' : 'error');
  btn.disabled = false;
  refreshTunnel();
});

$('tunnel-start-btn').addEventListener('click', async () => {
  show('tunnel-log', true);
  setMsg('tunnel-msg', 'Starting…', '');
  const r = await api.tunnelStart();
  setMsg('tunnel-msg', r.success ? `Running on ${r.url}` : (r.error || 'Failed'), r.success ? 'success' : 'error');
  refreshTunnel();
});

$('tunnel-stop-btn').addEventListener('click', async () => {
  await api.tunnelStop();
  setMsg('tunnel-msg', 'Stopped.', '');
  refreshTunnel();
});

api.onTunnelLog((text) => {
  const el = $('tunnel-log');
  el.textContent += text;
  if (el.textContent.length > 100000) el.textContent = el.textContent.slice(-80000);
  el.scrollTop = el.scrollHeight;
});

// ─── Boot ─────────────────────────────────────────────────────────────────

refreshServer();
refreshMacros();
refreshMcp();
refreshTunnel();

// Poll the server view: the VM and container can change state without an event
// reaching us (a VM stopped from a terminal, a container killed externally).
// The expensive probes behind this are cached in the main process for 30s, so
// the poll is cheap; it is deliberately slower than that cache is fresh.
setInterval(refreshServer, 10000);
