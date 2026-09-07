const { contextBridge, ipcRenderer } = require('electron');

// Explicit allowlist — contextIsolation is on and the renderer gets nothing
// beyond what is named here.
contextBridge.exposeInMainWorld('electronAPI', {
  // Server
  serverStatus: () => ipcRenderer.invoke('server:status'),
  serverStart: () => ipcRenderer.invoke('server:start'),
  serverStop: () => ipcRenderer.invoke('server:stop'),
  serverRestart: () => ipcRenderer.invoke('server:restart'),
  serverInstall: () => ipcRenderer.invoke('server:install'),
  serverCommand: (command) => ipcRenderer.invoke('server:command', command),
  saveProperties: (changes) => ipcRenderer.invoke('server:save-properties', changes),
  onServerLog: (cb) => {
    ipcRenderer.removeAllListeners('server:log');
    ipcRenderer.on('server:log', (_, text) => cb(text));
  },
  onServerEvent: (cb) => {
    ipcRenderer.removeAllListeners('server:event');
    ipcRenderer.on('server:event', (_, event) => cb(event));
  },
  onServerStopped: (cb) => {
    ipcRenderer.removeAllListeners('server:stopped');
    ipcRenderer.on('server:stopped', (_, info) => cb(info));
  },

  // Macros
  macrosList: () => ipcRenderer.invoke('macros:list'),
  macrosRead: (file) => ipcRenderer.invoke('macros:read', file),
  macrosSave: (file, text) => ipcRenderer.invoke('macros:save', file, text),
  macrosDelete: (file) => ipcRenderer.invoke('macros:delete', file),
  macrosSetEnabled: (id, enabled) => ipcRenderer.invoke('macros:set-enabled', id, enabled),
  macrosOpenFolder: () => ipcRenderer.invoke('macros:open-folder'),

  // Claude Code MCP
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpInstall: () => ipcRenderer.invoke('mcp:install'),
  mcpUninstall: () => ipcRenderer.invoke('mcp:uninstall'),

  // Cloudflare tunnel
  cloudflaredCheck: () => ipcRenderer.invoke('cloudflared:check'),
  cloudflaredInstall: () => ipcRenderer.invoke('cloudflared:install'),
  cloudflaredAuthStatus: () => ipcRenderer.invoke('cloudflared:auth-status'),
  cloudflaredLogin: () => ipcRenderer.invoke('cloudflared:login'),
  cloudflaredTunnelStatus: () => ipcRenderer.invoke('cloudflared:tunnel-status'),
  cloudflaredSetupTunnel: (domain) => ipcRenderer.invoke('cloudflared:setup-tunnel', domain),
  tunnelStart: () => ipcRenderer.invoke('tunnel:start'),
  tunnelStop: () => ipcRenderer.invoke('tunnel:stop'),
  tunnelStatus: () => ipcRenderer.invoke('tunnel:status'),
  onTunnelUrl: (cb) => ipcRenderer.on('tunnel:url-update', (_, url) => cb(url)),
  onTunnelLog: (cb) => ipcRenderer.on('tunnel:log', (_, text) => cb(text)),

  // Embedded Claude Code terminal
  ptySpawn: (cols, rows, skipPerms) => ipcRenderer.invoke('pty:spawn', cols, rows, skipPerms),
  ptyWrite: (data) => ipcRenderer.send('pty:write', data),
  ptyResize: (cols, rows) => ipcRenderer.send('pty:resize', cols, rows),
  ptyKill: () => ipcRenderer.send('pty:kill'),
  onPtyData: (cb) => {
    ipcRenderer.removeAllListeners('pty:data');
    ipcRenderer.on('pty:data', (_, data) => cb(data));
  },
  onPtyExit: (cb) => {
    ipcRenderer.removeAllListeners('pty:exit');
    ipcRenderer.on('pty:exit', () => cb());
  },

  // Shell
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openDataFolder: () => ipcRenderer.invoke('shell:open-data'),

  // Auto-update (sdk/ui/update-bar.js consumes these)
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_, info) => cb(info)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
});
