#!/bin/sh
# Mutation check: reintroduce each bug and assert the suite goes RED.
# A green suite proves nothing until a broken build fails it.
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0

mutate() {
  desc=$1; file=$2; from=$3; to=$4
  cp "$file" "$file.bak"
  python3 - "$file" "$from" "$to" <<'PY'
import sys
p,f,t=sys.argv[1],sys.argv[2],sys.argv[3]
s=open(p).read()
if f not in s:
    print("MUTATION-NOOP"); sys.exit(9)
open(p,'w').write(s.replace(f,t,1))
PY
  if [ $? -eq 9 ]; then
    echo "  SKIP (pattern absent — mutation is a no-op): $desc"
    mv "$file.bak" "$file"; FAIL=$((FAIL+1)); return
  fi
  if node --test 'test/*.js' >/dev/null 2>&1; then
    echo "  NOT CAUGHT: $desc"; FAIL=$((FAIL+1))
  else
    echo "  caught:     $desc"; PASS=$((PASS+1))
  fi
  mv "$file.bak" "$file"
}

echo "Mutation testing (each must be CAUGHT):"

# ── lib/console-bridge.js ─────────────────────────────────────────────────

mutate "chat message truncated at the first colon" lib/console-bridge.js \
  "  { event: 'PlayerMessage', re: /^\[Chat\]\s*(?<player>[^:]+):\s*(?<message>.*)\$/ }," \
  "  { event: 'PlayerMessage', re: /^\[Chat\]\s*(?<player>[^:]+):\s*(?<message>[^:]*)\$/ },"

mutate "partial line dropped at a chunk boundary" lib/console-bridge.js \
  "  const remainder = lines.pop() ?? '';" \
  "  const remainder = '';"

mutate "embedded newline stripped instead of refused (command injection)" lib/console-bridge.js \
  "  if (/[\r\n]/.test(trimmed)) {
    throw new Error('buildCommand: a command may not contain a newline (it would inject a second command)');
  }" \
  "  ;"

mutate "null byte accepted in a command" lib/console-bridge.js \
  "  if (/\0/.test(trimmed)) throw new Error('buildCommand: a command may not contain a null byte');" \
  "  ;"

mutate "commands sent without a terminating newline" lib/console-bridge.js \
  "  return \`\${trimmed.replace(/^\//, '')}\n\`;" \
  "  return trimmed.replace(/^\//, '');"

mutate "unobservable mcpews events reported as supported" lib/console-bridge.js \
  "  return SUPPORTED_EVENTS.includes(name);" \
  "  return true;"

# ── lib/runtime.js ────────────────────────────────────────────────────────

mutate "macOS tries to run a BDS binary Mojang never shipped" lib/runtime.js \
  "  return platform === 'darwin' ? 'container' : 'native';" \
  "  return 'native';"

mutate "JSONL parsed as a single JSON blob (breaks multi-VM)" lib/runtime.js \
  "    try {
      vms.push(JSON.parse(text));
    } catch {
      skipped.push(text.slice(0, 120));
    }" \
  "    vms.push(JSON.parse(text));"

mutate "missing VM status defaults to Running" lib/runtime.js \
  "  return found ? (found.status || 'Unknown') : 'Absent';" \
  "  return found ? (found.status || 'Running') : 'Absent';"

mutate "Stopped counts as a usable VM" lib/runtime.js \
  "  return status === 'Running';" \
  "  return status !== 'Absent';"

mutate "nerdctl loses sudo (containerd is a system service here)" lib/runtime.js \
  "  return ['shell', VM_NAME, 'sudo', 'nerdctl', ...args];" \
  "  return ['shell', VM_NAME, 'nerdctl', ...args];"

mutate "unrunnable limactl aborts the fallback search" lib/runtime.js \
  "  if (bundledPath && exists(bundledPath) && canRun(bundledPath)) return bundledPath;" \
  "  if (bundledPath && exists(bundledPath)) return bundledPath;"

mutate "Homebrew limactl locations removed" lib/runtime.js \
  "  for (const candidate of ['/opt/homebrew/bin/limactl', '/usr/local/bin/limactl']) {" \
  "  for (const candidate of []) {"

mutate "console pipe drops -i (server console becomes unwritable)" lib/runtime.js \
  "  return nerdctlArgs(['exec', '-i', CONTAINER_NAME, 'sh']);" \
  "  return nerdctlArgs(['exec', CONTAINER_NAME, 'sh']);"

mutate "shell quoting removed (command injection through the VM shell)" lib/runtime.js \
  "  return \`'\${String(value).replace(/'/g, \"'\\\\''\")}'\`;" \
  "  return String(value);"

mutate "sendCommandLine stops rejecting a newline" lib/runtime.js \
  "  if (/[\r\n]/.test(text)) {
    throw new Error('sendCommandLine: command may not contain a newline');
  }" \
  "  ;"

# ── lib/macros.js ─────────────────────────────────────────────────────────

mutate "unknown action type silently guessed instead of refused" lib/macros.js \
  "    throw new Error(\`unknown action type \"\${action.type}\" — refusing to guess a command for it\`);" \
  "    return String(action.type);"

mutate "missing required action field allowed through" lib/macros.js \
  "      throw new Error(\`action \"\${action.type}\" is missing required field \"\${field}\"\`);" \
  "      ;"

mutate "newline accepted in an action field (command injection)" lib/macros.js \
  "  return !/[\r\n\0]/.test(value);" \
  "  return true;"

mutate "target validation removed" lib/macros.js \
  "  if ('target' in config && !isValidTarget(config.target)) {" \
  "  if (false) {"

mutate "a row with a bad action runs its good half anyway" lib/macros.js \
  "      failure = e.message;
        break;" \
  "      continue;"

mutate "unsupported trigger no longer reported (rows silently never fire)" lib/macros.js \
  "  if (!isSupportedEvent(event)) {" \
  "  if (false) {"

mutate "macro version check dropped" lib/macros.js \
  "  if (doc.version !== SUPPORTED_VERSION) {" \
  "  if (false) {"

mutate "unknown condition type passes instead of failing closed" lib/macros.js \
  "    default:
      return false;
  }
}" \
  "    default:
      return true;
  }
}"

mutate "unsafe placeholder value injected into a live command" lib/macros.js \
  "    return isSafeValue(value) ? String(value) : '';" \
  "    return String(value === undefined ? '' : value);"

# ── lib/bds.js ────────────────────────────────────────────────────────────

mutate "unmodelled server.properties keys discarded on save" lib/bds.js \
  "  const merged = { ...DEFAULTS, ...existing, ...changes };" \
  "  const merged = { ...DEFAULTS, ...changes };"

mutate "newline accepted in a property value" lib/bds.js \
  "  if (/[\r\n]/.test(str)) {" \
  "  if (false) {"

mutate "enum properties no longer validated" lib/bds.js \
  "  if (ENUMS[key] && !ENUMS[key].includes(str)) {" \
  "  if (false) {"

mutate "container publishes TCP instead of UDP (accepts no players)" lib/bds.js \
  "    '-p', \`\${port}:\${port}/udp\`," \
  "    '-p', \`\${port}:\${port}\`,"

mutate "container drops -i (no console to write to)" lib/bds.js \
  "    'run', '-d', '-i'," \
  "    'run', '-d',"

mutate "a macOS BDS download is attempted instead of erroring" lib/bds.js \
  "    throw new Error(\`downloadUrl: Mojang ships no BDS build for \${platform} — use the container runtime\`);" \
  "    return 'https://example.invalid/bedrock-server.zip';"

# ── lib/bridge-protocol.js ────────────────────────────────────────────────

mutate "control port stops checking the token" lib/bridge-protocol.js \
  "  if (!tokenMatches(lower[TOKEN_HEADER], expectedToken)) {" \
  "  if (false) {"

mutate "browser-originated requests accepted (CSRF onto the control port)" lib/bridge-protocol.js \
  "  if (lower.origin) return { ok: false, status: 403, error: 'origin-bearing requests are not accepted' };" \
  "  ;"

mutate "token comparison accepts an empty expected secret" lib/bridge-protocol.js \
  "  if (!provided || !expected) return false;" \
  "  ;"

mutate "unknown control ops accepted" lib/bridge-protocol.js \
  "  if (!COMMANDS.includes(op)) {" \
  "  if (false) {"

mutate "roster keeps players across a server stop" lib/bridge-protocol.js \
  "      case 'ServerStopping':
        this.players.clear();
        break;" \
  "      case 'ServerStopping':
        break;"

mutate "event buffer becomes unbounded" lib/bridge-protocol.js \
  "    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);" \
  "    ;"

mutate "recent() exposes the live buffer" lib/bridge-protocol.js \
  "    return this.events.slice(this.events.length - n);" \
  "    return this.events;"

# ── lib/cloudflared.js ────────────────────────────────────────────────────

mutate "ingress continuation keys ignored" lib/cloudflared.js \
  "    if (kv && current) applyKey(current, kv[1], kv[2]);" \
  "    if (false) applyKey(current, kv[1], kv[2]);"

mutate "hostname validation accepts anything (shell injection)" lib/cloudflared.js \
  "  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\$/i.test(host);" \
  "  return true;"

mutate "tunnel renders an http service for a UDP game" lib/cloudflared.js \
  "    \`    service: \${scheme}://localhost:\${port}\`," \
  "    \`    service: http://localhost:\${port}\`,"

mutate "configured no longer requires a tunnel id" lib/cloudflared.js \
  "    configured: !!(tunnel && hostname)," \
  "    configured: !!hostname,"

# ── lib/failsafe.js ───────────────────────────────────────────────────────

mutate "failsafe stops recording failures" lib/failsafe.js \
  "  recent.push({ at: Date.now(), op, message, context });" \
  "  ;"

mutate "failsafe buffer becomes unbounded" lib/failsafe.js \
  "  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);" \
  "  ;"

echo
echo "caught $PASS / $((PASS+FAIL))"
[ "$FAIL" -eq 0 ] || exit 1
