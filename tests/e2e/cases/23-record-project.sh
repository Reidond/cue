#!/bin/bash
# A recording goes into the active project's Notes/ and says which project it belongs to.
source "$(dirname "$0")/../lib.sh"
need_whisper

# Projects made by hand: a folder with project.json, and a bare folder.
mkdir -p "$CUE_HOME/Documents/Cue/Interviews" "$CUE_HOME/Documents/Cue/Other project/Notes"
echo '{ "name" : "Interviews", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Interviews/project.json"
dialogue "$FIXTURES/dialogues/sync.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Interviews CUE_REHEARSE_RECORD=1 \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Project: Interviews" 10
wait_log "Transcript saved: .*/Documents/Cue/Interviews/Notes/" 120
wait_log "Notes ready" 180

notes=$(ready_notes)
assert_file "$notes"
[[ $notes == */Documents/Cue/Interviews/Notes/*.md ]] || fail "notes should be in Interviews/Notes: $notes"
assert_contains "$notes" '^project: "Interviews"$'
assert_contains "$notes" "^## Transcript"
assert_eq "$(find_notes | wc -l | tr -d ' ')" 1 "expected exactly one notes file"
assert_eq "$(ls "$CUE_HOME/Documents/Cue/Other project/Notes" | wc -l | tr -d ' ')" 0 "other projects get nothing"
