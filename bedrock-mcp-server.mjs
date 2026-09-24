#!/usr/bin/env node
//
// MCP server exposing the running Bedrock server to Claude Code.
//
// Registered by the app as:
//   claude mcp add minecraft -s user -e MENTAT_BRIDGE_TOKEN=… \
//     -- node bedrock-mcp-server.mjs --port 19134
//
// It holds no game logic: every call is forwarded to the app's loopback
// control port, which owns the console pipe. That split is deliberate — the
// app is the single writer to the server console, so two clients cannot
// interleave half-written commands into stdin.
//
// Speaks JSON-RPC 2.0 over stdio directly. No SDK dependency: this file ships
// inside an Electron app whose asar is not an npm install target, and the
// three methods below are the whole protocol surface it needs.

import process from 'node:process';
import readline from 'node:readline';

const PROTOCOL_VERSION = '2024-11-05';
const TOKEN_HEADER = 'x-mentat-token';

function parsePort(argv) {
  const index = argv.indexOf('--port');
  if (index === -1) return 19134;
  const port = Number(argv[index + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port ${argv[index + 1]} is not a valid port`);
  }
  return port;
}

const PORT = parsePort(process.argv);
const TOKEN = process.env.MENTAT_BRIDGE_TOKEN || '';

/**
 * Forward one operation to the app.
 * Never throws: a tool call must come back as a readable message, because an
 * exception here surfaces to the user as an opaque MCP transport failure.
 */
async function callBridge(body) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: TOKEN },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { error: `control port returned non-JSON (${response.status}): ${text.slice(0, 200)}` };
    }
    if (!response.ok) return { error: payload.error || `control port returned ${response.status}` };
    return payload;
  } catch (e) {
    // The overwhelmingly common cause is that the app is not running, so say
    // that rather than reporting a bare ECONNREFUSED.
    return {
      error: `cannot reach the Mentat MCBES app on 127.0.0.1:${PORT} — `
        + `is it running? (${e.message})`,
    };
  }
}

const TOOLS = [
  {
    name: 'run_command',
    description: 'Run one Minecraft Bedrock console command on the local server, as an operator. '
      + 'Give the command without a leading slash, e.g. "time set day".',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Console command, no leading slash' } },
      required: ['command'],
    },
    run: (args) => callBridge({ op: 'command', command: String(args.command ?? '') }),
  },
  {
    name: 'say',
    description: 'Broadcast a chat message to every player on the server.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    run: (args) => callBridge({ op: 'say', message: String(args.message ?? '') }),
  },
  {
    name: 'list_players',
    description: 'List the players currently online, as tracked from the server console.',
    inputSchema: { type: 'object', properties: {} },
    run: () => callBridge({ op: 'players' }),
  },
  {
    name: 'recent_events',
    description: 'Read recent server events. ONLY player join, player leave and chat messages are '
      + 'observable — the bridge reads the server console, so block, movement and item events do not exist.',
    inputSchema: {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 1, maximum: 500, default: 50 } },
    },
    run: (args) => callBridge({ op: 'events', count: Number(args.count) || 50 }),
  },
  {
    name: 'server_status',
    description: 'Whether the server is running and ready, which runtime it uses, and its port.',
    inputSchema: { type: 'object', properties: {} },
    run: () => callBridge({ op: 'status' }),
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;

  // A notification has no id and must not be answered.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'mentat-mcbes', version: '1.0.0' },
      });

    case 'notifications/initialized':
    case 'initialized':
      return undefined;

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return replyError(id, -32602, `unknown tool ${params?.name}`);
      const result = await tool.run(params.arguments || {});
      // Report a bridge failure as tool content with isError, not as a
      // protocol error: the model can read and act on the former.
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!result.error,
      });
    }

    case 'ping':
      return reply(id, {});

    default:
      if (isNotification) return undefined;
      return replyError(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return replyError(null, -32700, 'parse error');
  }
  // Errors are answered rather than thrown: an unhandled rejection would kill
  // the server and take the whole MCP connection with it.
  handle(message).catch((e) => {
    if (message.id !== undefined && message.id !== null) replyError(message.id, -32603, e.message);
  });
});

rl.on('close', () => process.exit(0));
