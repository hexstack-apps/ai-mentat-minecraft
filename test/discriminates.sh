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


# ── lib/macros.js — builder schema ────────────────────────────────────────

mutate "builder offers a trigger the bridge cannot deliver" lib/macros.js \
  "const TRIGGER_SPECS = [" \
  "const TRIGGER_SPECS = [
  { event: 'PlayerTransform', type: 'trigger:on_player_transform', label: 'Player moves', placeholders: ['player'] },"

mutate "requiredFields returns optional inputs too" lib/macros.js \
  "  return spec.inputs.filter((i) => i.required).map((i) => i.name);" \
  "  return spec.inputs.map((i) => i.name);"

mutate "newAction stops pre-filling declared defaults" lib/macros.js \
  "    if (input.default !== undefined) config[input.name] = input.default;" \
  "    ;"

mutate "newAction stops defaulting a select to its first option" lib/macros.js \
  "    else if (input.type === 'select' && input.options) config[input.name] = input.options[0];" \
  "    ;"

mutate "newRow accepts an unfireable event instead of falling back" lib/macros.js \
  "  const trigger = TRIGGER_SPECS.find((t) => t.event === event) || TRIGGER_SPECS[0];" \
  "  const trigger = { event, type: \`trigger:on_\${event}\`, label: event };"

mutate "the dimension_is limitation note is dropped" lib/macros.js \
  "    note: 'The console bridge does not report a dimension. Only \"any\" can match; '" \
  "    note2: 'The console bridge does not report a dimension. Only \"any\" can match; '"

mutate "builderSchema hides an action from the form" lib/macros.js \
  "    actions: Object.entries(ACTIONS).map(([type, spec]) => ({" \
  "    actions: Object.entries(ACTIONS).slice(1).map(([type, spec]) => ({"

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

# ── lib/ttl-cache.js ──────────────────────────────────────────────────────

mutate "probe cache never caches (main process blocks on every poll)" lib/ttl-cache.js \
  "    if (cachedAt !== null && now - cachedAt < ttlMs) return value;" \
  "    ;"

mutate "cache never expires (stale VM status forever)" lib/ttl-cache.js \
  "    cachedAt = clock();
    return value;" \
  "    cachedAt = Infinity;
    return value;"

mutate "freshness stamped before the probe, not after" lib/ttl-cache.js \
  "    value = fn(...args);
    // Stamp the time AFTER the call: a probe that takes 20s should be fresh
    // for ttl from when it finished, not from when it started, or a slow probe
    // is stale the moment it returns and runs again immediately.
    cachedAt = clock();" \
  "    cachedAt = clock();
    value = fn(...args);"

mutate "invalidate stops forcing a re-probe" lib/ttl-cache.js \
  "  wrapped.invalidate = () => { cachedAt = null; value = undefined; };" \
  "  wrapped.invalidate = () => {};"


echo
echo "caught $PASS / $((PASS+FAIL))"
[ "$FAIL" -eq 0 ] || exit 1
