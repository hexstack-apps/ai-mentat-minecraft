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

  const edit = document.createElement('button');
  edit.className = 'btn secondary';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => openBuilder(entry.file));
  row.appendChild(edit);

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


// ─── Macro builder ────────────────────────────────────────────────────────
//
// Every control here is generated from the schema the main process serves
// (lib/macros.js), so adding an action type there makes it appear in this form
// with no change to this file. The compile preview comes from the real
// compiler over IPC rather than being reimplemented — a preview computed
// independently would eventually disagree with what actually runs.

let schema = null;
let draft = null;        // the v2 document being edited
let draftFile = null;    // its filename, or null until first save
let draftEnabled = false;

function inputControl(spec, value, onChange) {
  let el;
  if (spec.type === 'select') {
    el = document.createElement('select');
    for (const option of spec.options || []) {
      const o = document.createElement('option');
      o.value = option;
      o.textContent = option;
      el.appendChild(o);
    }
    el.value = value !== undefined && value !== '' ? String(value) : (spec.options || [''])[0];
  } else {
    el = document.createElement('input');
    el.type = spec.type === 'number' ? 'number' : 'text';
    if (spec.placeholder) el.placeholder = spec.placeholder;
    el.value = value !== undefined && value !== null ? String(value) : '';
  }
  el.className = 'builder__input';
  // 'input' for text (live preview), 'change' for selects.
  el.addEventListener(spec.type === 'select' ? 'change' : 'input', () => onChange(el.value));
  return el;
}

function labelled(text, control) {
  const wrap = document.createElement('label');
  wrap.className = 'builder__field';
  const span = document.createElement('span');
  span.className = 'builder__field-label';
  span.textContent = text;
  wrap.appendChild(span);
  wrap.appendChild(control);
  return wrap;
}

function selectFrom(items, valueOf, labelOf, current, onChange) {
  const el = document.createElement('select');
  for (const item of items) {
    const o = document.createElement('option');
    o.value = valueOf(item);
    o.textContent = labelOf(item);
    el.appendChild(o);
  }
  if (current !== undefined && current !== null) el.value = String(current);
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

/** The event a row listens for, read from the document the same way the compiler does. */
function rowEvent(row) {
  return (row.when && row.when.config && row.when.config.eventName) || 'PlayerJoin';
}

function renderActionEditor(row, action, index) {
  const box = document.createElement('div');
  box.className = 'builder__item';

  const head = document.createElement('div');
  head.className = 'builder__item-head';
  head.appendChild(selectFrom(schema.actions, (a) => a.type, (a) => a.label, action.type, async (type) => {
    // Changing type replaces the config wholesale: the old fields belong to a
    // different command and silently carrying them over would produce values
    // the new action ignores.
    const r = await api.macrosNewAction(type);
    if (!r.ok) return;
    row.actions[index] = r.action;
    renderBuilder();
  }));

  const remove = document.createElement('button');
  remove.className = 'icon-btn';
  remove.title = 'Remove this action';
  remove.textContent = '✕';
  remove.addEventListener('click', () => {
    row.actions.splice(index, 1);
    renderBuilder();
  });
  head.appendChild(remove);
  box.appendChild(head);

  const spec = schema.actions.find((a) => a.type === action.type);
  const fields = document.createElement('div');
  fields.className = 'builder__fields';
  for (const input of (spec ? spec.inputs : [])) {
    const control = inputControl(input, action.config[input.name], (v) => {
      action.config[input.name] = v;
      refreshPreview();
    });
    fields.appendChild(labelled(input.label + (input.required ? ' *' : ''), control));
  }
  box.appendChild(fields);
  return box;
}

function renderConditionEditor(row, condition, index) {
  const box = document.createElement('div');
  box.className = 'builder__item';

  const head = document.createElement('div');
  head.className = 'builder__item-head';

  if (index > 0) {
    head.appendChild(selectFrom(schema.joinOperators, (o) => o, (o) => o,
      (condition.joinOperator || 'AND').toUpperCase(), (v) => { condition.joinOperator = v; refreshPreview(); }));
  }

  head.appendChild(selectFrom(schema.conditions, (c) => c.type, (c) => c.label, condition.type, (type) => {
    const spec = schema.conditions.find((c) => c.type === type);
    row.conditions[index] = { id: condition.id, type, label: spec.label, config: {}, negate: false, joinOperator: condition.joinOperator || 'AND' };
    renderBuilder();
  }));

  const negate = document.createElement('label');
  negate.className = 'inline-check';
  const negateBox = document.createElement('input');
  negateBox.type = 'checkbox';
  negateBox.checked = !!condition.negate;
  negateBox.addEventListener('change', () => { condition.negate = negateBox.checked; refreshPreview(); });
  negate.appendChild(negateBox);
  negate.appendChild(document.createTextNode(' not'));
  head.appendChild(negate);

  const remove = document.createElement('button');
  remove.className = 'icon-btn';
  remove.title = 'Remove this condition';
  remove.textContent = '✕';
  remove.addEventListener('click', () => { row.conditions.splice(index, 1); renderBuilder(); });
  head.appendChild(remove);
  box.appendChild(head);

  const spec = schema.conditions.find((c) => c.type === condition.type);
  const fields = document.createElement('div');
  fields.className = 'builder__fields';
  for (const input of (spec ? spec.inputs : [])) {
    condition.config = condition.config || {};
    fields.appendChild(labelled(input.label, inputControl(input, condition.config[input.name], (v) => {
      condition.config[input.name] = v;
      refreshPreview();
    })));
  }
  box.appendChild(fields);

  // A condition the transport cannot answer says so here, not after the row
  // silently fails to fire.
  if (spec && spec.note) {
    const note = document.createElement('p');
    note.className = 'builder__note';
    note.textContent = spec.note;
    box.appendChild(note);
  }
  return box;
}

function renderRowEditor(row, index) {
  const card = document.createElement('div');
  card.className = 'builder__row';

  const head = document.createElement('div');
  head.className = 'builder__row-head';
  const title = document.createElement('span');
  title.className = 'builder__row-title';
  title.textContent = `Rule ${index + 1}`;
  head.appendChild(title);

  const enabled = document.createElement('label');
  enabled.className = 'inline-check';
  const enabledBox = document.createElement('input');
  enabledBox.type = 'checkbox';
  enabledBox.checked = row.enabled !== false;
  enabledBox.addEventListener('change', () => { row.enabled = enabledBox.checked; refreshPreview(); });
  enabled.appendChild(enabledBox);
  enabled.appendChild(document.createTextNode(' enabled'));
  head.appendChild(enabled);

  const removeRow = document.createElement('button');
  removeRow.className = 'icon-btn';
  removeRow.title = 'Remove this rule';
  removeRow.textContent = '✕';
  removeRow.addEventListener('click', () => { draft.rows.splice(index, 1); renderBuilder(); });
  head.appendChild(removeRow);
  card.appendChild(head);

  // WHEN — only the events the console bridge can deliver are offered.
  const when = document.createElement('div');
  when.className = 'builder__clause';
  const whenLabel = document.createElement('span');
  whenLabel.className = 'builder__keyword';
  whenLabel.textContent = 'WHEN';
  when.appendChild(whenLabel);
  when.appendChild(selectFrom(schema.triggers, (t) => t.event, (t) => t.label, rowEvent(row), (event) => {
    const trigger = schema.triggers.find((t) => t.event === event);
    row.when = { id: row.when ? row.when.id : `${row.id}-when`, type: trigger.type, label: trigger.label, config: { eventName: trigger.event } };
    renderBuilder();
  }));
  const trigger = schema.triggers.find((t) => t.event === rowEvent(row));
  if (trigger) {
    const hint = document.createElement('span');
    hint.className = 'builder__hint';
    hint.textContent = `available: ${trigger.placeholders.map((p) => `{${p}}`).join(' ')}`;
    when.appendChild(hint);
  }
  card.appendChild(when);

  // IF
  const ifClause = document.createElement('div');
  ifClause.className = 'builder__clause builder__clause--stack';
  const ifLabel = document.createElement('span');
  ifLabel.className = 'builder__keyword';
  ifLabel.textContent = 'IF';
  ifClause.appendChild(ifLabel);
  const conditions = document.createElement('div');
  conditions.className = 'builder__list';
  (row.conditions || []).forEach((c, i) => conditions.appendChild(renderConditionEditor(row, c, i)));
  const addCondition = document.createElement('button');
  addCondition.className = 'btn secondary builder__add';
  addCondition.textContent = '+ condition';
  addCondition.addEventListener('click', () => {
    const spec = schema.conditions[0];
    row.conditions = row.conditions || [];
    row.conditions.push({ id: `${row.id}-c${row.conditions.length}`, type: spec.type, label: spec.label, config: {}, negate: false, joinOperator: 'AND' });
    renderBuilder();
  });
  conditions.appendChild(addCondition);
  ifClause.appendChild(conditions);
  card.appendChild(ifClause);

  // DO
  const doClause = document.createElement('div');
  doClause.className = 'builder__clause builder__clause--stack';
  const doLabel = document.createElement('span');
  doLabel.className = 'builder__keyword';
  doLabel.textContent = 'DO';
  doClause.appendChild(doLabel);
  const actions = document.createElement('div');
  actions.className = 'builder__list';
  (row.actions || []).forEach((a, i) => actions.appendChild(renderActionEditor(row, a, i)));
  const addAction = document.createElement('button');
  addAction.className = 'btn secondary builder__add';
  addAction.textContent = '+ action';
  addAction.addEventListener('click', async () => {
    const r = await api.macrosNewAction('say');
    if (!r.ok) return;
    row.actions = row.actions || [];
    row.actions.push(r.action);
    renderBuilder();
  });
  actions.appendChild(addAction);
  doClause.appendChild(actions);
  card.appendChild(doClause);

  // `results` are part of the v2 schema but not edited here. Show them so a
  // round trip through the builder visibly preserves rather than drops them.
  if (Array.isArray(row.results) && row.results.length) {
    const kept = document.createElement('p');
    kept.className = 'builder__note';
    kept.textContent = `${row.results.length} result step(s) from the original macro are preserved but not editable here.`;
    card.appendChild(kept);
  }

  return card;
}

function renderBuilder() {
  if (!draft || !schema) return;
  show('builder', true);
  $('builder-name').value = draft.name || '';
  $('builder-file').textContent = draftFile ? draftFile : '(unsaved)';
  $('builder-enabled').checked = draftEnabled;

  const rows = $('builder-rows');
  rows.textContent = '';
  if (!draft.rows.length) {
    const empty = document.createElement('p');
    empty.className = 'step-desc';
    empty.textContent = 'No rules yet. Add one to decide what happens and when.';
    rows.appendChild(empty);
  }
  draft.rows.forEach((row, i) => rows.appendChild(renderRowEditor(row, i)));
  refreshPreview();
}

/** Ask the main process to compile the draft, and show exactly what will run. */
async function refreshPreview() {
  if (!draft) return;
  draft.name = $('builder-name').value.trim() || draft.name;
  const r = await api.macrosPreview(draft);
  const pre = $('builder-preview');
  const lines = [];
  if (!r.ok) {
    lines.push(...r.errors.map((e) => `! ${e}`));
  } else {
    for (const [event, bound] of Object.entries(r.byEvent)) {
      for (const entry of bound) {
        lines.push(`on ${event}:`);
        for (const command of entry.commands) lines.push(`    ${command}`);
      }
    }
    for (const skip of r.skipped) lines.push(`! rule ${skip.rowId || '?'} will not run — ${skip.reason}`);
  }
  pre.textContent = lines.length ? lines.join('\n') : '(nothing will run yet)';
}

function macroFileName(doc) {
  const slug = String(doc.name || 'macro').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'macro';
  return `${slug}-${doc.id}.macro`;
}

async function openBuilder(file) {
  if (!schema) schema = await api.macrosSchema();
  const r = await api.macrosRead(file);
  if (!r.success) {
    setMsg('macros-msg', r.error || 'Could not open that macro', 'error');
    return;
  }
  try {
    draft = JSON.parse(r.text);
  } catch (e) {
    setMsg('macros-msg', `That file is not valid JSON: ${e.message}`, 'error');
    return;
  }
  draftFile = file;
  const listed = await api.macrosList();
  draftEnabled = (listed.enabled || []).includes(draft.id);
  setMsg('builder-msg', '', '');
  renderBuilder();
}

$('macros-new-btn').addEventListener('click', async () => {
  if (!schema) schema = await api.macrosSchema();
  const created = await api.macrosNew('Untitled macro');
  draft = created.macro;
  draftFile = null;
  draftEnabled = false;
  const row = await api.macrosNewRow('PlayerJoin');
  draft.rows.push(row.row);
  setMsg('builder-msg', '', '');
  renderBuilder();
});

$('builder-add-row').addEventListener('click', async () => {
  const r = await api.macrosNewRow('PlayerJoin');
  draft.rows.push(r.row);
  renderBuilder();
});

$('builder-name').addEventListener('input', () => {
  draft.name = $('builder-name').value;
  $('builder-file').textContent = draftFile ? draftFile : '(unsaved)';
});

$('builder-save').addEventListener('click', async () => {
  if (!draft) return;
  draft.name = $('builder-name').value.trim() || 'Untitled macro';
  // Keep the filename stable once saved: renaming the file on every title edit
  // would strand the enabled-macro list and litter the folder with orphans.
  const file = draftFile || macroFileName(draft);
  const r = await api.macrosSave(file, JSON.stringify(draft, null, 2));
  if (!r.success) {
    setMsg('builder-msg', r.error || 'Save failed', 'error');
    return;
  }
  draftFile = file;
  await api.macrosSetEnabled(draft.id, $('builder-enabled').checked);
  setMsg('builder-msg', `Saved to ${file}.`, 'success');
  $('builder-file').textContent = file;
  refreshMacros();
});

$('builder-duplicate').addEventListener('click', async () => {
  if (!draft) return;
  const created = await api.macrosNew(`${draft.name} copy`);
  // A duplicate must get a NEW id: the id is what the enabled list keys on, so
  // sharing one would make enabling the copy enable the original too.
  draft = { ...draft, id: created.macro.id, name: created.macro.name, createdAt: created.macro.createdAt };
  draftFile = null;
  draftEnabled = false;
  setMsg('builder-msg', 'Duplicated — unsaved until you press Save.', '');
  renderBuilder();
});

$('builder-delete').addEventListener('click', async () => {
  if (!draftFile) {
    draft = null;
    show('builder', false);
    return;
  }
  const r = await api.macrosDelete(draftFile);
  if (!r.success) {
    setMsg('builder-msg', r.error || 'Delete failed', 'error');
    return;
  }
  draft = null;
  draftFile = null;
  show('builder', false);
  setMsg('macros-msg', 'Macro deleted.', '');
  refreshMacros();
});

$('builder-close').addEventListener('click', () => {
  draft = null;
  draftFile = null;
  show('builder', false);
});

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
