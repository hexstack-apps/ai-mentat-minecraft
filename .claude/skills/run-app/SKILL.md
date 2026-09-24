---
name: run-app
description: Build, run and drive the Hexstack Mentat MCBES Electron app. Use when asked to start the app, screenshot it, or confirm a change works in the real GUI.
---

Hexstack Mentat MCBES is an Electron desktop app. Drive it through the Playwright REPL at
`.claude/skills/run-app/driver.mjs`. macOS has a real window server, so there
is no xvfb and no `--no-sandbox` — unlike the generic Electron recipe.

## Prerequisites

```sh
npm install
# Electron's postinstall does not always fetch the binary. If
# node_modules/electron/dist is missing:
(cd node_modules/electron && node install.js)
```

## Run

```sh
npm run bundle                 # main points at the esbuild output; regenerate first
node .claude/skills/run-app/driver.mjs .
```

Wrap in tmux for agent use:

```sh
tmux new-session -d -s app -x 200 -y 50
tmux send-keys -t app 'node .claude/skills/run-app/driver.mjs .' Enter
timeout 25 bash -c 'until tmux capture-pane -t app -p | grep -q "driver>"; do sleep 0.3; done'
tmux send-keys -t app 'launch' Enter
timeout 90 bash -c 'until tmux capture-pane -t app -p | grep -q "launched\."; do sleep 0.5; done'
tmux send-keys -t app 'ss landing' Enter
```

Screenshots land in `/tmp/shots/` (override with `SCREENSHOT_DIR`).

### Commands

| command | what it does |
|---|---|
| `launch` | launch the app, attach main-process and renderer log capture |
| `ss [name]` | screenshot -> `/tmp/shots/<name>.png` |
| `tab <name>` | switch tab by its `data-tab` value, report whether the panel went active |
| `click <css>` | click via DOM `.click()`, not coordinates |
| `fill <css> <value>` | set an input value and dispatch `input` |
| `text [css]` | print innerText |
| `eval <js>` | evaluate in the page, print JSON |
| `errors` | renderer console errors/warnings and page errors |
| `mainlog` | main-process stdout/stderr — where the real diagnostics go |
| `windows` | list windows |
| `quit` | close the app and exit |

## Gotchas

- **`npm run bundle` must pass the project dir.** `sdk/utils/bundle-electron.js`
  defaults `projectDir` to `path.resolve(__dirname, '..')`, which is
  `<repo>/sdk` in the submodule layout, not the repo root. The npm scripts here
  pass `.` explicitly. The other ai-mentat repos still omit it, so their
  `bundle`/`gui` scripts fail.
- **The driver must live inside the repo.** Run it from `/tmp` and Node cannot
  resolve `playwright-core` from the repo's `node_modules`.
- **`playwright-core` is a devDependency here on purpose.** Installed
  `--no-save` it gets pruned by the next `npm install`.
- **Screenshots can catch a stale compositor frame** — a shot right after a tab
  switch sometimes shows the previous panel with both tabs highlighted. It is
  the screenshot, not the app: `eval` the DOM to check real state. Batch a
  `tab`/`ss` pair with ~1.5s between commands.
- **The driver session tears the app down after roughly a minute.** Launched
  plainly with `npm run gui` the app stays up indefinitely, so this is a
  harness artifact — do the interactions promptly after `launch`, and relaunch
  if `page.evaluate` starts reporting "Target page ... has been closed".
- **Async work in `eval` needs an IIFE:** `eval (async()=>...)()`. A bare
  top-level `await` is a syntax error.
- The Server tab probes Lima. With no VM it reports Absent; a leftover broken VM reports Broken. Neither blocks the GUI.

## Human path

```sh
npm run gui    # opens the window; Ctrl-C to quit
```
