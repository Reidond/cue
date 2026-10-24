#!/bin/bash
# When the second pass can't run (here whisper-cli is missing), the note keeps the live transcript,
# its page and the session log say what went wrong, and the summary is written all the same.
source "$(dirname "$0")/../lib.sh"
need_whisper

cue_defaults speakerName string "Andrii Test"
cue_defaults autoAnswer bool false
mkdir -p "$CUE_HOME/Documents/Cue/Interviews"
echo '{ "name" : "Interviews", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Interviews/project.json"
dialogue "$FIXTURES/dialogues/sync.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Interviews CUE_REHEARSE_RECORD=1 CUE_WHISPER_CLI="$CASE_DIR/nowhere/whisper-cli" \
    CUE_SNAPSHOT="$CASE_DIR/cue.png" \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Notes ready" 180

log=$(session_log)
assert_contains "$log" "⚠︎ Couldn't improve the transcript: whisper-cli not found at $CASE_DIR/nowhere/whisper-cli — the live transcript is kept$"
assert_not_contains "$log" "Transcript improved"
steps=$(grep -o -E "Transcript saved|Improving transcript…|Couldn't improve the transcript|Writing summary…|Notes ready" "$log" | paste -s -d, -)
assert_eq "$steps" "Transcript saved,Improving transcript…,Couldn't improve the transcript,Writing summary…,Notes ready" \
    "the summary should still be written after the failed step: $steps"

# The note has the live transcript: every line the live recognition heard, as it heard it.
notes=$(ready_notes)
assert_file "$notes"
grep -o -E '\*\*\[(Participant|Andrii Test)\]\*\* .*' "$log" | sed -E 's/^\*\*\[[^]]+\]\*\* //' > "$CASE_DIR/live.txt"
assert_eq "$(wc -l < "$CASE_DIR/live.txt" | tr -d ' ')" 4 "live recognition should have heard the four lines"
while IFS= read -r line; do
    grep -q -F -- "$line" "$notes" || fail "the note should keep the live line: $line"
done < "$CASE_DIR/live.txt"
assert_contains "$notes" "^\*\*00:00:05 · Andrii Test\*\*$"

# The summary is there, and the note is named after it.
assert_contains "$notes" "^## Summary"
assert_contains "$notes" '^title: "E2E rehearsal notes"'

# The note's page keeps its steps, with what went wrong.
dashboard_page "Interviews/notes" "whisper-cli not found"
page=$CASE_DIR/page.txt
assert_contains "$page" "Saving audio$"
assert_contains "$page" "Improving transcript$"
assert_contains "$page" "transcript is kept"
assert_contains "$page" "Writing summary$"
assert_contains "$page" "^Summary$"
