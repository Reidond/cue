#!/bin/bash
# With Keep audio off, a recording's notes have no audio; the sides are still recorded for
# processing and deleted once the notes are ready.
source "$(dirname "$0")/../lib.sh"
need_whisper

cue_defaults keepAudio bool false
mkdir -p "$CUE_HOME/Documents/Cue/Interviews"
echo '{ "name" : "Interviews", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Interviews/project.json"
dialogue "$FIXTURES/dialogues/sync.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Interviews CUE_REHEARSE_RECORD=1 CUE_SHOW_SETTINGS=1 CUE_SNAPSHOT="$CASE_DIR/cue.png" \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"

# The preference, in Settings › Notes.
snapshot_text "$CASE_DIR/cue-settings.png" > "$CASE_DIR/settings.txt"
assert_contains "$CASE_DIR/settings.txt" "^Keep audio$"
assert_contains "$CASE_DIR/settings.txt" "about 15 MB per hour"

wait_log "Transcript saved" 120
wait_log "Audio not kept \(Keep audio is off\): [0-9]+:[0-9]{2}" 10
wait_log "Working audio: .*/recordings/" 10
wait_log "Notes ready" 180
wait_log "Working audio removed: " 5

notes=$(ready_notes)
assert_file "$notes"
assert_contains "$notes" "^## Transcript"
assert_not_contains "$notes" "^audio:" "the notes shouldn't name any audio"
assert_not_contains "$(session_log)" "Audio saved"
assert_eq "$(find "$CUE_HOME" -name '*.m4a' -o -name '*.wav' | wc -l | tr -d ' ')" 0 "no audio should be left anywhere"
