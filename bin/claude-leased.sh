#!/usr/bin/env bash
# claude-leased: run Claude Code with a credential leased from the Switchboard broker (contract 1).
#
# Lease, run, report. The broker picks the active healthy lane and hands back a setup token for it; this
# wrapper puts that token in the environment (never on a command line), runs the real claude with the
# arguments it was given, and reports the outcome so Switchboard can cool the lane down or fail over.
#
# Environment:
#   SWITCHBOARD_CLIENT_KEY   required; the sb-key issued on Switchboard's Gateway tab
#   SWITCHBOARD_BROKER_URL   optional; default: try 127.0.0.1:8318, then the WSL default gateway
#   SWITCHBOARD_ACCOUNT      optional; pin a lane by account id
#   CLAUDE_BIN               optional; the real claude (default: the first claude on PATH that is not this file)
#
# Exit codes: claude's own; 75 when no lane is healthy (retry later, see stderr); 78 on bad configuration.
set -u

key="${SWITCHBOARD_CLIENT_KEY:-}"
[ -n "$key" ] || { echo "claude-leased: SWITCHBOARD_CLIENT_KEY is not set" >&2; exit 78; }

self="$(readlink -f "${BASH_SOURCE[0]}")"
bin="${CLAUDE_BIN:-}"
if [ -z "$bin" ]; then
    while read -r candidate; do
        [ "$(readlink -f "$candidate")" = "$self" ] && continue
        bin="$candidate"; break
    done < <(which -a claude 2>/dev/null)
fi
[ -n "$bin" ] && [ -x "$bin" ] || { echo "claude-leased: no real claude found; set CLAUDE_BIN" >&2; exit 78; }

# curl calls read the key from a config file on stdin, so it never appears in a process list.
call() { # call <method> <url> [json-body]
    local method="$1" url="$2" body="${3:-}"
    printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$key" |
        curl -s -S --max-time 10 -K - -X "$method" ${body:+--data-binary "$body"} -w '\n%{http_code}' "$url" 2>/dev/null
}

discover() {
    if [ -n "${SWITCHBOARD_BROKER_URL:-}" ]; then echo "${SWITCHBOARD_BROKER_URL%/}"; return 0; fi
    local gw candidate
    gw="$(ip route 2>/dev/null | awk '/default/ {print $3; exit}')"
    local reply code
    for candidate in "http://127.0.0.1:8318" ${gw:+"http://$gw:8318"}; do
        reply="$(call GET "$candidate/v1/info")"; code="${reply##*$'\n'}"
        case "$code" in
            200) echo "$candidate"; return 0 ;;
            401|403) echo "claude-leased: the broker at $candidate rejected SWITCHBOARD_CLIENT_KEY (HTTP $code)" >&2; return 2 ;;
        esac
    done
    return 1
}

broker="$(discover)"; found=$?
[ "$found" = 2 ] && exit 78
[ "$found" = 0 ] || { echo "claude-leased: no Switchboard broker answered (set SWITCHBOARD_BROKER_URL)" >&2; exit 75; }

lease_body="{\"provider\":\"claude\",\"harness\":\"claude\"${SWITCHBOARD_ACCOUNT:+,\"account\":\"$SWITCHBOARD_ACCOUNT\"}}"
response="$(call POST "$broker/v1/lease" "$lease_body")"
status="${response##*$'\n'}"
json="${response%$'\n'*}"

# Pull the fields out with node (jq is not a given in the distro). The env map is exported as-is.
read_field() { printf '%s' "$json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const v=process.argv[1].split(".").reduce((o,k)=>o==null?undefined:o[k],j);process.stdout.write(v==null?"":String(v))}catch(e){}})' "$1"; }

if [ "$status" != "200" ]; then
    reason="$(read_field reason)"; retry="$(read_field retryAfterSeconds)"; resets="$(read_field resetsAt)"
    echo "claude-leased: no lane leased (HTTP $status, ${reason:-no reason}); retry after ${retry:-?} s, resets ${resets:-?}" >&2
    [ "$status" = "503" ] && exit 75
    exit 78
fi

lease_id="$(read_field leaseId)"; lane_id="$(read_field laneId)"; label="$(read_field accountLabel)"
echo "claude-leased: lane ${lane_id} (${label}), lease ${lease_id}, headroom session $(read_field headroom.session)% weekly $(read_field headroom.weekly)%" >&2

# Export every env entry the broker returned. Values are read by node and written as NAME<TAB>VALUE lines,
# so nothing is ever evaluated by the shell.
while IFS=$'\t' read -r name value; do
    [ -n "$name" ] && export "$name=$value"
done < <(printf '%s' "$json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);for(const [k,v] of Object.entries(j.env||{}))process.stdout.write(k+"\t"+String(v).replace(/[\t\n]/g,"")+"\n")})')

# Run the real claude. When stdout is not a terminal (the bridge, T3) a copy of it is kept so the
# rate_limit_event line Claude prints before a limit failure can be reported with its reset time.
capture=""
if [ -t 1 ]; then
    "$bin" "$@"; code=$?
else
    capture="$(mktemp)"
    "$bin" "$@" | tee "$capture"; code=${PIPESTATUS[0]}
fi

outcome="ok"; rate_type=""; resets=""
if [ -n "$capture" ] && grep -q '"type":"rate_limit_event"' "$capture"; then
    line="$(grep '"type":"rate_limit_event"' "$capture" | tail -1)"
    rate_type="$(printf '%s' "$line" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).rate_limit_info.rateLimitType||""))}catch(e){}})')"
    resets="$(printf '%s' "$line" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).rate_limit_info.resetsAt||""))}catch(e){}})')"
    outcome="rate-limited"
elif [ "$code" -ne 0 ]; then
    outcome="error"
fi
[ -n "$capture" ] && rm -f "$capture"

report="{\"leaseId\":\"$lease_id\",\"laneId\":\"$lane_id\",\"outcome\":\"$outcome\",\"exitCode\":$code${rate_type:+,\"rateLimitType\":\"$rate_type\"}${resets:+,\"resetsAt\":$resets}}"
call POST "$broker/v1/lease/report" "$report" >/dev/null || echo "claude-leased: report failed (lease $lease_id, $outcome)" >&2
exit "$code"
