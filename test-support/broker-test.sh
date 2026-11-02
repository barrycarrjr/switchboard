set -u
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work=$(mktemp -d)
cp "$dir/../bin/switchboard-lease" "$work/claude-leased"; chmod +x "$work/claude-leased"
cp "$dir/broker-stub.mjs" "$work/broker-stub.mjs"
export STUB_LOG="$work/stub.log"
# A fake claude that never prints the token, only its length and what it was asked.
cat > "$work/fake-claude" <<'EOF'
#!/usr/bin/env bash
echo "fake-claude args: $* | token length: ${#CLAUDE_CODE_OAUTH_TOKEN} | token on argv: $(ps -o args= -p $$ | grep -c stub-token)"
case "${FAKE_MODE:-ok}" in
  fail) exit 3 ;;
  limit) echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1762041600,"rateLimitType":"seven_day"}}'; exit 1 ;;
esac
EOF
chmod +x "$work/fake-claude"
export SWITCHBOARD_CLIENT_KEY=sb-key-stub CLAUDE_BIN="$work/fake-claude"

node "$work/broker-stub.mjs" 8318 ok & stub=$!
sleep 1
echo "== 1. discovery + lease + ok run (stdout piped, so the copy path is used)"
SWITCHBOARD_BROKER_URL= "$work/claude-leased" -p "hello" | cat; echo "exit=$?"
echo "== 2. failing run reports error"
FAKE_MODE=fail "$work/claude-leased" -p "x" | cat; echo "exit=${PIPESTATUS[0]}"
echo "== 3. rate-limited run reports rateLimitType and resetsAt"
FAKE_MODE=limit "$work/claude-leased" -p "x" | cat; echo "exit=${PIPESTATUS[0]}"
echo "== 1b. no CLAUDE_BIN: the wrapper finds the native install under the home, with nothing on PATH"
mkdir -p "$work/home/.local/bin"; cp "$work/fake-claude" "$work/home/.local/bin/claude"
HOME="$work/home" CLAUDE_BIN= PATH="/usr/bin:/bin" "$work/claude-leased" -p "from-home" | cat; echo "exit=${PIPESTATUS[0]}"
echo "== 1c. no claude anywhere: exit 78 and the places tried"
mkdir -p "$work/empty"
HOME="$work/empty" CLAUDE_BIN= PATH="/usr/bin:/bin" "$work/claude-leased" -p "x"; echo "exit=$?"
echo "== 4. wrong key"
SWITCHBOARD_CLIENT_KEY=wrong "$work/claude-leased" -p "x"; echo "exit=$?"
kill $stub; wait $stub 2>/dev/null
echo "== 5. no healthy lane (503)"
node "$work/broker-stub.mjs" 8318 empty & stub=$!
sleep 1
"$work/claude-leased" -p "x"; echo "exit=$?"
kill $stub; wait $stub 2>/dev/null
echo "== stub log (what the broker received; the token must not appear in reports)"
cat "$STUB_LOG"
echo "token leaked into stub log: $(grep -c stub-token "$STUB_LOG")"
rm -rf "$work"
