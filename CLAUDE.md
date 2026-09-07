# CLAUDE.md — Hexstack Mentat MCBES

Electron desktop app that runs a Minecraft Bedrock Dedicated Server locally
with a GUI: a live console, a macro engine, a Claude Code MCP server, and a
Cloudflare named tunnel. Its headline feature is **running on macOS at all**.

## Provenance — read this before "fixing" something

The 2026-04 source (`_mentat-mcbes` / `_minecraft-runner` in the `hexstack`
monorepo) was lost in the 2026-08-30 `~/Projects` deletion and, unlike its
sibling `ai-mentat-n8n`, **no build survived** — there is no `app.asar` to
recover source from. This repo is a rebuild from four kinds of evidence, and
the difference matters when you are deciding whether something is a bug:

| Evidence | What it fixed in place |
|---|---|
| Session memory `project_minecraft_runner.md` | The console-bridge decision, the Lima/nerdctl specifics, the MCMacro webview wiring — **verified design notes, treat as authoritative** |
| `~/.claude.json` | The MCP registration really was `node bedrock-mcp-server.mjs --port 19134`, so a local control port on 19134 is original, not invented |
| Leftover app data at `~/Library/Application Support/mcmacro/macros/` | Real `.macro` **v2 documents** — the schema in `lib/macros.js` is transcribed from them, not designed. One is kept at `test/fixtures/` |
| `README.md` + the sibling apps | The feature set, the tab layout, and the family conventions |

**Reconstructed rather than recovered:** all of `electron-main.js`, the UI, and
the `lib/` split. The original file names differed — the console bridge lived
in `wsServer.js`, and `runtime.js` there was MCMacro's, patched to pass `opts`
through `startServer(port, opts)` into `wsServer.start()`.

**Not restored:** the macro *builder*. It was a prebuilt React app
(`mcmacro-ui` / `mcmacro-engine`) committed as compiled artifacts and mounted
in an Electron `<webview>`, with `navigator.clipboard` polyfilled over IPC in
`mcmacro-preload.js`. Its source repo is gone and the artifacts went with the
monorepo. What exists here instead is the macro **engine and reporting**, which
reads and runs the real v2 format. If the `mcmacro` repo ever resurfaces, the
webview can be reattached over this engine.

**Also not restored:** `icon.png`. The build config therefore names no icon and
electron-builder falls back to the default Electron one. Drop an `icon.png` in
and add `"icon": "icon.png"` to `build.mac` / `build.win` / `build.linux`.

## Run and test

```sh
npm install
npm run gui            # esbuild the main process, then launch
npm test               # 124 unit tests, no deps, no Electron, no display
npm run test:mutation  # 44 mutation checks — every fix must fail when reverted
npm run download:lima  # fetch the bundled limactl (macOS/Linux)
```

## Architecture

| Layer | File | Notes |
|---|---|---|
| Main process | `electron-main.js` | server / VM / macro / tunnel / MCP supervision |
| Preload bridge | `preload.js` | contextIsolation on, explicit allowlist |
| UI | `app.html` + `app.css` + `app.js` | 5 tabs; JS in its own file so the CSP can forbid inline script |
| MCP server | `bedrock-mcp-server.mjs` | stdio JSON-RPC, forwards to the control port |
| Terminal backend | `pty-helper.py` | real PTY behind the embedded xterm.js |
| **Pure logic** | **`lib/*.js`** | **the only unit-testable code** |
| Shared plumbing | `sdk/` (submodule) | bundling, auto-update, publish/release, data-dir |

**Rule: new platform-conditional or parsing logic goes in `lib/` with a test.**
`electron-main.js` cannot be loaded outside Electron and exports nothing.

## Design decisions worth preserving

### The console bridge, and why not mcpews

Commands reach the server the way an operator's do — through BDS's stdin — and
events are read from its stdout.

**mcpews was evaluated and rejected.** It exposes ~45 event types, but it needs
a player to type `/wsserver <url>` in-game **every session**, and it
authenticates as a player, so it does not work on an offline-mode server at
all. The console bridge auto-connects when the server starts and is indifferent
to online/offline mode.

**bedrock-protocol was also rejected**: it requires native C++ compilation
(raknet-native + cmake) on the user's machine.

**The cost is real and must stay visible.** Only `PlayerJoin`, `PlayerLeave`
and `PlayerMessage` are observable — that is all BDS prints. A saved macro may
well listen for `PlayerTransform`, which can never fire here.
`macros.rowSupport()` therefore returns a *reason*, the Macros tab renders it,
and the MCP tool description says it out loud. **Never register a listener that
cannot fire.**

### Two runtimes, because Mojang ships no macOS build

`native` on Windows/Linux (BDS spawned directly, commands to its own stdin);
`container` on macOS (BDS in a Linux container in a Lima VM).

Lima specifics, all load-bearing:

- **`vmType: vz`** — Apple's Virtualization.framework, so there is no QEMU to
  install.
- **`LIMA_HOME` is `~/.mc-lima`, deliberately short.** Lima puts its control
  socket inside its home; macOS `UNIX_PATH_MAX` is 104 bytes and a longer path
  fails as a confusing "socket path too long".
- **Every `nerdctl` call needs `sudo`** — containerd runs as a system service
  in this VM, not rootless.
- **The VM is left running on exit; only the container is stopped.** Booting a
  VM takes minutes, a container seconds.
- **One persistent `nerdctl exec -i` shell**, not one exec per command. Under a
  macro firing on every chat line, a VM round trip per command is the
  difference between instant and visibly laggy.

### Other decisions with teeth

**`limactl` resolution: bundled → PATH → Homebrew.** The bundled binary wins so
behaviour does not change with what the user happens to have installed. The
Homebrew fallbacks exist because a Finder-launched app inherits a launchd PATH
without `/opt/homebrew/bin`, so a working `brew install lima` read as "not
installed". A present-but-unrunnable binary does not abort the search.

**`limactl list --json` is JSONL** — one object per line, not an array. One
`JSON.parse` works on a one-VM machine and fails on every multi-VM one.

**VM status is a string, never a boolean.** "Stopped", "Broken" and "Absent"
need different UI and different remedies. No status reports `Unknown`, never
`Running`.

**Stopping always sends the console `stop` first.** That is what makes BDS
flush the world; killing the process risks a corrupt level.

**`server.properties` is merged, not overwritten.** Keys the GUI does not model
are carried through, because losing a hand-set key on every save is data loss
the user could only find by reading the file.

**The container publishes UDP.** Bedrock is RakNet over UDP; a TCP publish
produces a server that looks up and accepts no players.

**A macro row is all-or-nothing.** If one action fails to compile, the whole
row is skipped — running half a row leaves the world in a state the author
never described.

**`EPIPE` / `ERR_STREAM_DESTROYED` are not fatal.** The console pipe and the
PTY both produce them whenever a child exits mid-write; treating them as fatal
in `uncaughtException` used to quit the whole app (fixed 2026-04-16 across all
three apps, and reintroduced here deliberately).

## Security decisions

This repo is public and the app runs processes on the user's machine.

**The control port is token-guarded, not just loopback-bound.** Every request
to it runs a Minecraft command with operator authority, and 127.0.0.1 is not a
boundary against the local machine: any local process, and any web page the
user visits (form POST, DNS rebinding), can reach it. So a 32-byte secret is
generated per install, stored `0600` as `bridge-token`, handed to the MCP
server **through its environment** (never argv, which is world-readable in the
process table), and compared with `timingSafeEqual`. Requests carrying any
`Origin` header are refused outright — no legitimate client is a web page.

Two empty strings are equal-length, so `timingSafeEqual('', '')` is **true**.
`tokenMatches` rejects empty values explicitly; without that, a failed token
read would let any client in with an empty header. There is a mutation test on
it.

**Container commands are single-quoted for the VM shell.** Container mode
writes through `sh`, so a bare interpolation is a command-injection point — and
`say don't` is enough to trigger it by accident. POSIX has no escape inside
single quotes, hence the close/escape/reopen dance in `shellQuote`.

**Newlines are refused, never stripped**, in console commands, macro action
fields and `server.properties` values. A newline is how one command becomes
two, and stripping-and-continuing runs something the caller never checked.

**Every child process gets an argv array**, never a composed command string.
The tunnel hostname is additionally validated by `CF.isValidHostname()`.

**Renderer-supplied filenames go through `path.basename()`** before touching
the macros directory — otherwise `../../.claude/settings.json` is writable from
the renderer.

**`shell:open-external` allowlists `https:`** so a renderer string cannot
launch `file://` or a custom protocol handler.

**The renderer has a strict CSP** (`default-src 'none'`, `script-src 'self'`)
and `webSecurity` stays on. It only talks to the main process over IPC and
loads nothing from the network, so no exception is needed — and no handler is
an inline `onclick`.

## Error handling convention — fail-safe, never silent

`lib/failsafe.js`, shared verbatim with the sibling apps.

```js
const { quiet, attempt } = require('./lib/failsafe');
const text = quiet('cloudflared.readConfig', () => fs.readFileSync(p, 'utf8'), null);
attempt('settings.write', () => fs.writeFileSync(f, json));
```

**Rule: do not write `catch {}` for anything whose failure a user could
notice.** The `op` label must be a stable literal — it is what you grep for.
The remaining bare catches are process-kill calls where the failure is "it was
already dead".

## Gotchas

- `main` points at `electron-main.bundle.js`, esbuild output regenerated before
  every run. **Edit `electron-main.js`.**
- Use the glob: `node --test 'test/*.js'`. `node --test test/` treats the bare
  directory as a file named `test` and reports a spurious failure.
- `bedrock-mcp-server.mjs` ships as an `extraResource`, not inside the asar —
  `claude mcp add` registers an absolute path that `node` must be able to run.
- Data lives at `/.hexstack-app/ai-mentat-minecraft/data` (family contract),
  falling back to `~/.hexstack-app/...` when the filesystem root is not
  writable. Run `npm run setup` to prepare the root location.
- BDS itself is not downloaded on Windows/Linux: Mojang requires accepting the
  EULA on their download page, so the app points the user at the data folder
  instead of misrepresenting that consent.
- The Cloudflare tunnel **cannot carry public Bedrock traffic** on a standard
  plan — UDP through a tunnel is private-access only (WARP, or Spectrum). The
  wizard builds a correct config for that case and the FAQ states the limit;
  the answer for open public play is a forwarded port.
- `certs/` and `lima-bin/` are gitignored build/signing inputs.
- **`npm run bundle` passes the project dir explicitly.**
  `sdk/utils/bundle-electron.js` defaults `projectDir` to
  `path.resolve(__dirname, '..')`, which was the repo root when that file lived
  at `__shared__/scripts/` but is `<repo>/sdk` in the submodule layout. The
  scripts here pass `.`; **the other three ai-mentat repos still omit it, so
  their `bundle` and `gui` scripts fail** — worth fixing in the SDK.
- **Electron's postinstall may not fetch its binary.** If
  `node_modules/electron/dist` is missing after `npm install`, run
  `(cd node_modules/electron && node install.js)`.
- To run and screenshot the GUI, use the project skill at
  `.claude/skills/run-app/` — it documents the driver and its gotchas.
- **`server:status` probes are cached for 30s** (`lib/ttl-cache.js`). Uncached,
  every renderer poll spawned `limactl list --json` and `nerdctl images`
  synchronously, which flooded the failsafe buffer and blocked the main
  process. Call `invalidateProbes()` after anything that changes VM or image
  state.
- **A missing `settings.json` or `server.properties` is not a failure.** Both
  reads check existence first, because recording an expected first-run absence
  on every poll buries the errors the failsafe buffer exists to surface.
