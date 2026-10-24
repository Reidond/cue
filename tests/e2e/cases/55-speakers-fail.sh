#!/bin/bash
# When speakers can't be told apart (here the speaker models can't be fetched: a file is where their
# folder should be), the note keeps its transcript as it was, under the plain participant label; its
# page and the session log say what went wrong, and the summary is written all the same.
source "$(dirname "$0")/../lib.sh"
need_whisper

cue_defaults speakerName string "Andrii Test"
cue_defaults autoAnswer bool false
mkdir -p "$CUE_HOME/Documents/Cue/Library"
echo '{ "name" : "Library", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Library/project.json"
echo "not a folder" > "$CASE_DIR/blocked"
dialogue "$FIXTURES/dialogues/two-voices.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Library CUE_REHEARSE_RECORD=1 CUE_SPEAKER_MODELS="$CASE_DIR/blocked" \
    CUE_SNAPSHOT="$CASE_DIR/cue.png" \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Notes ready" 300

log=$(session_log)
steps=$(grep -o -E "Transcript improved|Finding speakers…|Couldn't tell speakers apart|Writing summary…|Notes ready" "$log" | paste -s -d, -)
assert_eq "$steps" "Transcript improved,Finding speakers…,Couldn't tell speakers apart,Writing summary…,Notes ready" \
    "the summary should still be written after the failed step: $steps"
assert_contains "$log" "⚠︎ Couldn't tell speakers apart: .+ — the transcript is kept as it was$"
assert_not_contains "$log" "✅ Speakers:"

# The improved transcript, as the second pass left it: one label for everyone on the call.
notes=$(ready_notes)
assert_contains "$notes" "^participants: Andrii Test, Participant$"
assert_eq "$(grep -c -E '^\*\*[0-9:]+ · Participant\*\*$' "$notes")" 2 "the call side's lines keep the plain label"
assert_not_contains "$notes" "Participant [0-9]"
assert_contains "$notes" "survey summary before then"
assert_contains "$notes" "^## Summary"

# The note's page keeps its steps, with what went wrong.
dashboard_page "Library/notes" "kept as it was"
page=$CASE_DIR/page.txt
assert_contains "$page" "Improving transcript$"
assert_contains "$page" "Finding speakers$"
assert_contains "$page" "already exists\. The transcript is kept as it was\.$" "the reason should read as one sentence"
assert_contains "$page" "Writing summary$"
assert_contains "$page" "^Summary$"
