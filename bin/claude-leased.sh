#!/usr/bin/env bash
# Reference client for Switchboard's Contract v1 lease broker (Ubuntu / WSL / LAN machine side).
#
# Replaces the claude command for bridges, schedulers and T3 Code: asks the Switchboard broker
# on :8318 for a credential lease, runs the real claude with that lease's env for this one
# process, and reports the outcome so the broker can cool the lane down or mark a revoked
# setup-token dead. Credentials stay in environment variables and curl stdin; nothing is
# written to a credential file and nothing is passed on a command line.
#
# Env in:
#   SWITCHBOARD_CLIENT_KEY  optional if saved in ~/.config/switchboard/client-key (or ~/.switchboard-key)
#   SWITCHBOARD_BROKER_URL  optional if saved in ~/.config/switchboard/broker-url (or ~/.switchboard-url);
#                           otherwise tries 127.0.0.1 then the WSL default-route host, on the port in
#                           ~/.config/switchboard/broker-port or 8318
#   SWITCHBOARD_ACCOUNT     optional account id hint
#   CLAUDE_BIN              optional path to the real claude binary (otherwise the next claude on PATH)
#
# Needs bash and curl, plus node or python3 to read the broker's JSON. A machine with neither
# stops before leasing, with a message, rather than running claude on whatever sign-in it has.
set -u

# The first line of the first readable file, CR stripped (a file written from Windows).
first_line_of() {
    local f v
    for f in "$@"; do
        if [ -f "$f" ] && [ -r "$f" ]; then
            IFS= read -r v < "$f" || true
            v="${v%$'\r'}"
            [ -n "$v" ] && { printf '%s' "$v"; return 0; }
        fi
    done
    return 1
}

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

# T3 Code checks each provider with `--version` every few minutes, and `--help` is asked for by
# hand. Neither runs a model, so neither borrows an account: a lease for each would cost a
# settings write and a feed line every time, and a lane cooling down would make T3 mark the
# provider broken.
if [ "$#" -eq 1 ]; then
    case "$1" in --version|-v|--help|-h) exec "$bin" "$1" ;; esac
fi

conf="${XDG_CONFIG_HOME:-$HOME/.config}/switchboard"
key="${SWITCHBOARD_CLIENT_KEY:-}"
[ -n "$key" ] || key="$(first_line_of "$conf/client-key" "$HOME/.switchboard-key")"
[ -n "$key" ] || { echo "claude-leased: SWITCHBOARD_CLIENT_KEY is not set (and no ~/.config/switchboard/client-key found)" >&2; exit 78; }

# An account id goes into the lease request's JSON as it is, so only the characters an id is
# made of are accepted; anything else would let the hint change the request.
account="${SWITCHBOARD_ACCOUNT:-}"
case "$account" in *[!A-Za-z0-9._-]*) echo "claude-leased: SWITCHBOARD_ACCOUNT \"$account\" is not an account id" >&2; exit 78 ;; esac

# The broker answers in JSON and jq is not a given, so node reads it, or python3 where node is
# missing (a plain Ubuntu server has python3 and no node; found on a LAN worker, 2026-11-02).
# Each is run once rather than looked up, because a version-manager shim (asdf, mise) can be on
# PATH and still fail to run. python3 runs isolated (-I): plain -c imports from the working
# folder first, so a json.py in the project T3 runs this from would read the lent token.
if node -e 0 >/dev/null 2>&1; then json_tool=node
elif python3 -I -c 0 >/dev/null 2>&1; then json_tool=python3
else echo "claude-leased: needs node or python3 to read the broker's reply, and this machine has neither" >&2; exit 78
fi

# jget <dotted.path>: one field of the JSON on stdin, or nothing.
jget() {
    if [ "$json_tool" = node ]; then
        node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const v=process.argv[1].split(".").reduce((o,k)=>o==null?undefined:o[k],j);process.stdout.write(v==null?"":String(v))}catch(e){}})' "$1"
    else
        python3 -I -c '
import json, sys
try:
    v = json.loads(sys.stdin.read())
    for k in sys.argv[1].split("."):
        v = v.get(k) if isinstance(v, dict) else None
    if v is not None:
        sys.stdout.write(str(v).lower() if isinstance(v, bool) else str(v))
except Exception:
    pass' "$1"
    fi
}

# jenv: the "env" map of the JSON on stdin as NAME<TAB>VALUE lines, tabs and newlines removed,
# so nothing the broker sends is ever evaluated by the shell.
jenv() {
    if [ "$json_tool" = node ]; then
        node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);for(const [k,v] of Object.entries(j.env||{}))process.stdout.write(k+"\t"+String(v).replace(/[\t\n]/g,"")+"\n")})'
    else
        python3 -I -c '
import json, sys
for k, v in (json.loads(sys.stdin.read()).get("env") or {}).items():
    sys.stdout.write(k + "\t" + str(v).replace("\t", "").replace("\n", "") + "\n")'
    fi
}

# curl calls read the key from a config file on stdin, so it never appears in a process list.
call() { # call <method> <url> [json-body]
    local method="$1" url="$2" body="${3:-}"
    printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$key" |
        curl -s -S --max-time 10 -K - -X "$method" ${body:+--data-binary "$body"} -w '\n%{http_code}' "$url" 2>/dev/null
}

discover() {
    # A machine on the LAN has no default-route host that is the broker, so its address is
    # saved in a file next to the key (written by `switchboard t3 setup`). A saved address is
    # still checked, so one that stopped answering is "no broker" (75, try later), not a
    # configuration error.
    local explicit="${SWITCHBOARD_BROKER_URL:-${SWITCHBOARD_URL:-}}"
    [ -n "$explicit" ] || explicit="$(first_line_of "$conf/broker-url" "$HOME/.switchboard-url")"
    local port gw candidate reply code
    port="$(first_line_of "$conf/broker-port")"
    case "$port" in ''|*[!0-9]*) port=8318 ;; esac
    local candidates=()
    if [ -n "$explicit" ]; then
        candidates=("${explicit%/}")
    else
        gw="$(ip route 2>/dev/null | awk '/default/ {print $3; exit}')"
        candidates=("http://127.0.0.1:$port")
        [ -n "$gw" ] && candidates+=("http://$gw:$port")
    fi
    for candidate in "${candidates[@]}"; do
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
[ "$found" = 0 ] || { echo "claude-leased: no Switchboard broker answered (set SWITCHBOARD_BROKER_URL or ~/.config/switchboard/broker-url)" >&2; exit 75; }

lease_body="{\"provider\":\"claude\",\"harness\":\"claude\"${account:+,\"account\":\"$account\"}}"
response="$(call POST "$broker/v1/lease" "$lease_body")"
status="${response##*$'\n'}"
json="${response%$'\n'*}"
read_field() { printf '%s' "$json" | jget "$1"; }

if [ "$status" != "200" ]; then
    reason="$(read_field reason)"; retry="$(read_field retryAfterSeconds)"; resets="$(read_field resetsAt)"
    echo "claude-leased: no lane leased (HTTP $status, ${reason:-no reason}); retry after ${retry:-?} s, resets ${resets:-?}" >&2
    [ "$status" = "503" ] && exit 75
    exit 78
fi

lease_id="$(read_field leaseId)"; lane_id="$(read_field laneId)"; label="$(read_field accountLabel)"
echo "claude-leased: lane ${lane_id} (${label}), lease ${lease_id}, headroom session $(read_field headroom.session)% weekly $(read_field headroom.weekly)%" >&2

send_report() { # send_report <outcome> <exit code> [rate type] [resets at]
    local body="{\"leaseId\":\"$lease_id\",\"laneId\":\"$lane_id\",\"outcome\":\"$1\",\"exitCode\":$2${3:+,\"rateLimitType\":\"$3\"}${4:+,\"resetsAt\":$4}}"
    call POST "$broker/v1/lease/report" "$body" >/dev/null || echo "claude-leased: report failed (lease $lease_id, $1)" >&2
}

lent=0
while IFS=$'\t' read -r name value; do
    case "$name" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    export "$name=$value"
    lent=$((lent + 1))
done < <(printf '%s' "$json" | jenv)
# A lease with nothing in it would run claude on whatever sign-in this machine has, billing an
# account nobody chose. Refused, and reported so the broker does not count it as a good run.
if [ "$lent" -eq 0 ]; then
    echo "claude-leased: the broker lent no credential (or this machine could not read it); not running claude" >&2
    send_report error 78
    exit 78
fi
# An API key in the environment outranks Claude's OAuth token, so a leftover one would bill the
# API instead of the lent subscription.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; fi

# Run the real claude. When stdout is not a terminal (the bridge, T3) the usage-event lines are
# kept aside, so the rate_limit_event Claude prints before a limit failure can be reported with
# its reset time. Only those lines: a long T3 session prints megabytes of stream JSON.
capture=""
# A stop signal (T3 ending a session signals the whole process group) reaches claude directly;
# bash runs this once the pipeline has ended, so the report still goes out and nothing is left
# in /tmp.
on_signal() {
    [ -n "$capture" ] && rm -f "$capture"
    send_report error 143
    exit 143
}
trap on_signal TERM INT HUP
if [ -t 1 ]; then
    "$bin" "$@"; code=$?
else
    capture="$(mktemp)"
    "$bin" "$@" | tee >(grep --line-buffered '"type":"rate_limit_event"' > "$capture"); code=${PIPESTATUS[0]}
    wait "$!" 2>/dev/null || true # the filter may still be writing its last line
fi
trap - TERM INT HUP

outcome="ok"; rate_type=""; resets=""
# Only a "rejected" event means the account is out. Claude prints a rate_limit_event on ordinary
# runs too ("allowed", "allowed_warning"), and reporting those cooled every lane down until its
# weekly reset after one good run, so no lane could be leased (AI bridge, 2026-11-02).
line=""
[ -n "$capture" ] && line="$(grep '"status":"rejected"' "$capture" | tail -1)"
if [ -n "$line" ]; then
    rate_type="$(printf '%s' "$line" | jget rate_limit_info.rateLimitType)"
    resets="$(printf '%s' "$line" | jget rate_limit_info.resetsAt)"
    case "$rate_type" in *[!A-Za-z0-9_-]*) rate_type="" ;; esac
    case "$resets" in *[!0-9]*) resets="" ;; esac
    outcome="rate-limited"
elif [ "$code" -ne 0 ]; then
    outcome="error"
fi
[ -n "$capture" ] && rm -f "$capture"

send_report "$outcome" "$code" "$rate_type" "$resets"
exit "$code"
