# Sourced by every end-to-end case (see AGENTS.md › Testing). Gives the case a
# sandboxed Cue, ways to drive and wait on it, spoken audio, and assertions.
# Run cases through tests/e2e/run.sh, which builds the app and the tools.
set -uo pipefail
: "${CUE_APP:?run cases through tests/e2e/run.sh}"

CUE_BIN=$CUE_APP/Contents/MacOS/Cue
FIXTURES=$E2E_ROOT/fixtures
DOMAIN=com.andriishafar.cue.e2e.$E2E_CASE-$$
REAL_SUPPORT="$HOME/Library/Application Support/Cue"
CUE_PID=

# MARK: Results

fail() { echo "FAIL: $*"; exit 1; }
skip() { echo "SKIP: $*"; exit 77; }

# MARK: Sandbox — a fresh CUE_HOME and defaults domain for every case

CASE_DIR=$(mktemp -d "$E2E_WORK/$E2E_CASE.XXXX")
export CUE_HOME=$CASE_DIR/home
SUPPORT=$CUE_HOME/Application\ Support/Cue
mkdir -p "$SUPPORT" "$CUE_HOME/Documents"
# The speech model is 1.6 GB: link it in, never copy or download it.
[[ -d $REAL_SUPPORT/models ]] && ln -s "$REAL_SUPPORT/models" "$SUPPORT/models"
defaults delete $DOMAIN > /dev/null 2>&1
# Own settings domain and whisper-server port, so checkouts can run cases at the same time.
export CUE_DEFAULTS_DOMAIN=$DOMAIN
# The calendar and the apps using the microphone come from these files, never from the Mac
# (see `minutes_from_now` and `mic_apps`).
EVENTS=$CASE_DIR/events.json
MIC_APPS=$CASE_DIR/mic-apps
export CUE_WHISPER_PORT=$(for _ in $(seq 50); do port=$((20000 + RANDOM % 20000)); lsof -nP -iTCP:$port -sTCP:LISTEN > /dev/null 2>&1 || { echo $port; break; }; done)

if [[ $E2E_CLAUDE == fake ]]; then
    export CUE_CLAUDE_BIN=$E2E_BIN/fake-claude
    export FAKE_CLAUDE_LOG=$CASE_DIR/claude
    mkdir -p "$FAKE_CLAUDE_LOG"
fi

_finish() {
    local status=$?
    cue_stop
    pkill -f -- "whisper-server .*--port $CUE_WHISPER_PORT( |\$)" 2> /dev/null  # left behind if Cue was killed
    defaults delete $DOMAIN > /dev/null 2>&1
    rm -f "$HOME/Library/Preferences/$DOMAIN.plist"
    if [[ ($status == 0 || $status == 77) && $E2E_KEEP != 1 ]]; then
        rm -rf "$CASE_DIR"
    else
        echo "Sandbox kept: $CASE_DIR"
    fi
}
trap _finish EXIT

# MARK: Requirements

need_whisper() {
    [[ -f $REAL_SUPPORT/models/ggml-large-v3-turbo.bin ]] || skip "speech model not downloaded"
    [[ -x /opt/homebrew/bin/whisper-server || -x /usr/local/bin/whisper-server ]] || skip "whisper-server not installed"
}
need_real_claude() { [[ $E2E_CLAUDE == real ]] || skip "needs --real-claude"; }
# need_whisper_cli — the second pass's whisper-cli; its path is then in $WHISPER_CLI.
need_whisper_cli() {
    WHISPER_CLI=$(ls /opt/homebrew/bin/whisper-cli /usr/local/bin/whisper-cli 2> /dev/null | head -n 1)
    [[ -x $WHISPER_CLI ]] || skip "whisper-cli not installed"
}
need_voice() { say -v '?' | grep -q -E "^$1( |\\()" || skip "voice '$1' is not installed"; }

# MARK: Driving Cue

# cue_defaults KEY TYPE VALUE… — e.g. `cue_defaults language string uk`,
# `cue_defaults materials array a.md b.pdf`, `cue_defaults autoAnswer bool true`.
cue_defaults() { defaults write $DOMAIN "$1" "-$2" "${@:3}"; }

# cue_launch [VAR=value…] — starts the app in the background with live audio off
# (pass CUE_NO_LIVE_AUDIO=0 to override), the calendar read from $EVENTS and the
# microphone users from $MIC_APPS, and waits for its session log.
cue_launch() {
    local previous; previous=$(session_log)
    : > "$CASE_DIR/control"
    (
        export CUE_NO_LIVE_AUDIO=1 CUE_CONTROL=$CASE_DIR/control CUE_CALENDAR_EVENTS=$EVENTS CUE_MIC_APPS=$MIC_APPS
        for assignment in "$@"; do export "$assignment"; done
        exec "$CUE_BIN"
    ) >> "$CASE_DIR/cue.out" 2>&1 &
    CUE_PID=$!
    # A relaunch in the same case starts a new log (they are named by the second).
    wait_for "Cue to start" 30 _has_new_session_log "$previous"
}

# cue_stop — quits the app the way Ctrl-C does (clean shutdown), then makes sure.
cue_stop() {
    [[ -n $CUE_PID ]] || return 0
    kill -TERM "$CUE_PID" 2> /dev/null
    for _ in $(seq 50); do kill -0 "$CUE_PID" 2> /dev/null || break; sleep 0.2; done
    kill -KILL "$CUE_PID" 2> /dev/null
    wait "$CUE_PID" 2> /dev/null
    CUE_PID=
}

# cue_control COMMAND… — does in the running Cue what a click would (CUE_CONTROL):
# `new NAME`, `add PATH`, `start NAME`, `project NAME`, `ask TEXT`, `timestamp HH:MM:SS`,
# `page home|upcoming|NAME|NAME/answers|NAME/notes` for the dashboard,
# `assign EVENT | PROJECT` (quote it) and `notification record|dismiss`.
cue_control() { echo "$*" >> "$CASE_DIR/control"; }

# minutes_from_now N — the time N minutes from now (negative: ago) in ISO 8601, for $EVENTS:
# a JSON array of {title, start, end, and optionally id, series, calendar, url, location,
# notes, attendees, recurring}.
minutes_from_now() { date -u -v"$( (($1 < 0)) && echo "$1" || echo "+$1")"M +%Y-%m-%dT%H:%M:%SZ; }

# tomorrow_at HH:MM — that local time tomorrow, by the calendar (a day is not always 24 h: DST).
tomorrow_at() { date -u -r "$(date -v+1d -v"${1%%:*}"H -v"${1#*:}"M -v0S +%s)" +%Y-%m-%dT%H:%M:%SZ; }

# mic_apps [BUNDLE_ID…] — the processes using the microphone right now; none when the call app let go.
mic_apps() { printf '%s\n' "$@" > "$MIC_APPS"; }

# log_count REGEX — how many session log lines match.
log_count() { grep -c -E -- "$1" "$(session_log)"; }

cue_alive() { [[ -n $CUE_PID ]] && kill -0 "$CUE_PID" 2> /dev/null; }

# whisper_cli_spy [SECONDS] — writes $CASE_DIR/whisper-cli, for CUE_WHISPER_CLI: it notes how Cue runs
# it (the arguments, one per line, in whisper-args.txt; its scheduling priority in whisper-priority.txt),
# takes SECONDS longer if given, as a long call would, and runs the real whisper-cli.
whisper_cli_spy() {
    need_whisper_cli
    cat > "$CASE_DIR/whisper-cli" << EOF
#!/bin/bash
printf '%s\n' "\$@" > "$CASE_DIR/whisper-args.txt"
sleep ${1:-0.5}
ps -o pri= -p \$\$ | tr -d ' ' > "$CASE_DIR/whisper-priority.txt"
exec "$WHISPER_CLI" "\$@"
EOF
    chmod +x "$CASE_DIR/whisper-cli"
}

# cue_cli ARGS… — the app's command-line modes (--inspect, --render, …).
cue_cli() { CUE_NO_LIVE_AUDIO=1 "$CUE_BIN" "$@"; }

# MARK: Waiting

# wait_for "what" SECONDS command… — polls until the command succeeds; fails the
# case on timeout or as soon as a launched Cue exits.
wait_for() {
    local what=$1 timeout=$2
    shift 2
    local deadline=$(($(date +%s) + timeout))
    until "$@" > /dev/null 2>&1; do
        if [[ -n $CUE_PID ]] && ! kill -0 "$CUE_PID" 2> /dev/null; then
            echo "--- cue.out"; tail -n 40 "$CASE_DIR/cue.out"
            fail "Cue exited while waiting for $what"
        fi
        if (($(date +%s) >= deadline)); then
            [[ -n $(session_log) ]] && { echo "--- session log"; tail -n 40 "$(session_log)"; }
            fail "timed out after ${timeout}s waiting for $what"
        fi
        sleep 0.5
    done
}

# The newest session log (Application Support/Cue/sessions/*.md).
session_log() { ls -t "$SUPPORT"/sessions/*.md 2> /dev/null | head -n 1; }
_has_new_session_log() { local log; log=$(session_log); [[ -n $log && $log != "$1" ]]; }
_log_has() { local log; log=$(session_log); [[ -n $log ]] && grep -q -E -- "$1" "$log"; }

# wait_log REGEX SECONDS — waits for a line in the session log.
wait_log() { wait_for "log line /$1/" "$2" _log_has "$1"; }

# The notes file named by the last "Notes ready:" log line.
ready_notes() { grep -o 'Notes ready: .*' "$(session_log)" | tail -n 1 | cut -c 14-; }

# Every Markdown note under the sandbox's Documents (materials excluded).
find_notes() { find "$CUE_HOME/Documents" -name '*.md' -not -path '*/Materials/*' | sort; }

# summary_of NOTES — a note's summary: from its title to the transcript.
summary_of() { sed -n '/^# /,/^<!-- transcript -->$/p' "$1" | sed '$d'; }

# claude_requests KIND — what Cue sent the fake claude: answer-system, ask,
# summary-system or summary-input (all requests of that kind, oldest first).
claude_requests() {
    [[ $E2E_CLAUDE == fake ]] || fail "claude_requests needs the fake claude"
    cat "$FAKE_CLAUDE_LOG"/*-"$1".txt 2> /dev/null
}

# MARK: Audio and screens

# speech OUT.wav VOICE "text" — 16 kHz mono WAV spoken by a macOS voice.
speech() {
    need_voice "$2"
    local aiff=${1%.wav}.aiff
    say -v "$2" -o "$aiff" -- "$3" || fail "say -v $2 failed"
    afconvert -f WAVE -d LEI16@16000 -c 1 "$aiff" "$1" && rm -f "$aiff"
}

# dialogue SCRIPT OUTDIR — builds a call from a script of `side | voice | text`
# lines: one WAV per side (each line on its side, silence on the others) plus
# timeline.tsv (start, end, side, voice, text). Cached across runs.
dialogue() {
    local script=$1 out=$2 voice
    while IFS= read -r voice; do need_voice "$voice"; done < <(grep -v -E '^\s*(#|$|pause\s*\|)' "$script" | cut -d'|' -f2 | sed 's/^ *//; s/ *$//' | sort -u)
    local cache=$E2E_WORK/cache/$(shasum "$script" | cut -c 1-16)
    if [[ ! -f $cache/timeline.tsv ]]; then
        "$E2E_BIN/dialogue" "$script" "$cache" || fail "couldn't build dialogue from $script"
    fi
    mkdir -p "$out" && cp "$cache"/* "$out"/
}

# ocr PNG — the text Vision reads in an image, one line per text block.
ocr() { "$E2E_BIN/ocr" "$1"; }

# dashboard_page PAGE REGEX — with CUE_SNAPSHOT=$CASE_DIR/cue.png, shows a dashboard page
# and waits until its snapshot reads REGEX; the page's text is then in $CASE_DIR/page.txt.
dashboard_page() {
    cue_control page "$1"
    wait_for "the $1 page to show /$2/" 20 _dashboard_shows "$2"
}
_dashboard_shows() {
    local png=$CASE_DIR/cue-dashboard.png
    [[ -s $png ]] && ocr "$png" > "$CASE_DIR/page.txt" && grep -q -i -E -- "$1" "$CASE_DIR/page.txt"
}

# audio_length FILE — its length in seconds, as afinfo reads it.
audio_length() { afinfo "$1" 2> /dev/null | awk '/estimated duration:/ { print $3 }'; }

# audio_sync AUDIO TIMELINE [SIDE…] — succeeds when the recording has each line of a dialogue's
# timeline.tsv (of those SIDEs) where the timeline puts it, and silence elsewhere; prints what it measured.
audio_sync() { "$E2E_BIN/audio-sync" "$@"; }

# Waits for CUE_SNAPSHOT to write a PNG and prints its text.
snapshot_text() {
    wait_for "snapshot $1" 20 test -s "$1"
    sleep 2.5  # the next frame, so the window has settled
    ocr "$1"
}

# MARK: Assertions (patterns are case-insensitive extended regexes)

assert_file() { [[ -s $1 ]] || fail "${2:-expected a non-empty file at $1}"; }

assert_contains() {
    grep -q -i -E -- "$2" "$1" && return
    echo "--- $1"; head -c 6000 "$1"; echo
    fail "${3:-$(basename "$1") should match /$2/}"
}

assert_not_contains() {
    grep -q -i -E -- "$2" "$1" || return 0
    echo "--- matches in $1"; grep -n -i -E -- "$2" "$1" | head -n 20
    fail "${3:-$(basename "$1") should not match /$2/}"
}

assert_eq() { [[ $1 == "$2" ]] || fail "${3:-expected '$2', got '$1'}"; }

# assert_between NUMBER LOW HIGH [MESSAGE] — LOW ≤ NUMBER ≤ HIGH, decimals allowed.
assert_between() {
    awk -v n="$1" -v low="$2" -v high="$3" 'BEGIN { exit !(n != "" && n >= low && n <= high) }' \
        || fail "${4:-expected $1 to be between $2 and $3}"
}
