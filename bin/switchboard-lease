#!/usr/bin/env bash
# Reference client for Switchboard's Contract v1 lease broker (Ubuntu / WSL side).
#
# Replaces the claude command for bridges and schedulers: asks the Windows broker on
# :8318 for a credential lease, runs the real claude with that lease's env for this one
# process, and reports the outcome so the broker can cool the lane down or mark a revoked
# setup-token dead. Credentials stay in environment variables and curl stdin; nothing is
# written to a credential file and nothing is passed on a command line.
#
# Env in:
#   SWITCHBOARD_CLIENT_KEY  optional if saved in ~/.config/switchboard/client-key (or ~/.switchboard-key)
#   SWITCHBOARD_BROKER_URL  optional; otherwise tries 127.0.0.1:8318 then the WSL default-route host
#   SWITCHBOARD_ACCOUNT     optional account id hint
#   CLAUDE_BIN              optional path to the real claude binary (otherwise the next claude on PATH)
set -u

key="${SWITCHBOARD_CLIENT_KEY:-}"
if [ -z "$key" ]; then
    for kf in "${XDG_CONFIG_HOME:-$HOME/.config}/switchboard/client-key" "$HOME/.switchboard-key"; do
        if [ -r "$kf" ]; then
            IFS= read -r key < "$kf" || true
            key="${key%$'\r'}"
            [ -n "$key" ] && break
        fi
    done
fi
[ -n "$key" ] || { echo "claude-leased: SWITCHBOARD_CLIENT_KEY is not set (and no ~/.config/switchboard/client-key found)" >&2; exit 78; }

self="$(readlink -f "${BASH_SOURCE[0]}")"
bin="${CLAUDE_BIN:-}"
# Without CLAUDE_BIN: the native installer's place first. Under `wsl.exe --exec` the
# distro home's bin is not on PATH, while the Windows PATH is appended through
# interop, so a bare PATH search found nothing or, worse, the Windows claude (2026-11-01).
if [ -z "$bin" ] && [ -x "$HOME/.local/bin/claude" ]; then bin="$HOME/.local/bin/claude"; fi
if [ -z "$bin" ]; then
    while read -r candidate; do
        [ "$(readlink -f "$candidate")" = "$self" ] && continue
        case "$candidate" in /mnt/*) continue ;; esac # a Windows claude seen through interop is not the Linux one
        bin="$candidate"; break
    done < <(which -a claude 2>/dev/null)
fi
[ -n "$bin" ] && [ -x "$bin" ] || { echo "claude-leased: no real claude found (CLAUDE_BIN=${CLAUDE_BIN:-unset}, no $HOME/.local/bin/claude, none on PATH outside /mnt); set CLAUDE_BIN" >&2; exit 78; }

# curl calls read the key from a config file on stdin, so it never appears in a process list.
call() { # call <method> <url> [json-body]
    local method="$1" url="$2" body="${3:-}"
    printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$key" |
        curl -s -S --max-time 10 -K - -X "$method" ${body:+--data-binary "$body"} -w '\n%{http_code}' "$url" 2>/dev/null
}

discover() {
    local explicit="${SWITCHBOARD_BROKER_URL:-${SWITCHBOARD_URL:-}}"
    if [ -n "$explicit" ]; then echo "${explicit%/}"; return 0; fi
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
# Only a "rejected" event means the account is out. Claude prints a rate_limit_event on ordinary
# runs too ("allowed", "allowed_warning"), and reporting those cooled every lane down until its
# weekly reset after one good run, so no lane could be leased (AI bridge, 2026-11-02).
line=""
[ -n "$capture" ] && line="$(grep '"type":"rate_limit_event"' "$capture" | grep '"status":"rejected"' | tail -1)"
if [ -n "$line" ]; then
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
