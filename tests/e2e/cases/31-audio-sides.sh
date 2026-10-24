#!/bin/bash
# While a note is processed, each side of the call is in its own WAV (16-bit, 16 kHz) in a working
# folder named after the note's date, in sync with the call; the folder goes once the notes are ready.
source "$(dirname "$0")/../lib.sh"
need_whisper

mkdir -p "$CUE_HOME/Documents/Cue/Interviews"
echo '{ "name" : "Interviews", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Interviews/project.json"
dialogue "$FIXTURES/dialogues/sync.txt" "$CASE_DIR/call"
# A summary that takes a while, as the real one does, so the working copies can be checked meanwhile.
cue_launch CUE_PROJECT=Interviews CUE_REHEARSE_RECORD=1 FAKE_CLAUDE_SUMMARY_DELAY=10 \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Working audio: " 150
folder=$(grep -o 'Working audio: .*' "$(session_log)" | head -n 1 | sed -E 's/^Working audio: (.*) \(mic\.wav, call\.wav\)$/\1/')
notes=$(grep -o 'Transcript saved: .*' "$(session_log)" | cut -c 19-)
assert_file "$notes"

# Found from the note: Application Support/Cue/recordings/<the note's date: without colons>.
stamp=$(grep -m1 '^date: ' "$notes" | cut -c 7- | tr -d ':')
[[ $folder -ef $SUPPORT/recordings/$stamp ]] || fail "the working audio should be in recordings/$stamp, not $folder"
grep -q "Notes ready" "$(session_log)" && fail "the notes shouldn't be ready yet; the summary is still being written"

for side in mic call; do
    wav=$folder/$side.wav
    assert_file "$wav"
    afinfo "$wav" > "$CASE_DIR/$side.txt"
    assert_contains "$CASE_DIR/$side.txt" "File type ID: +WAVE"
    assert_contains "$CASE_DIR/$side.txt" "1 ch, +16000 Hz, Int16"
done
assert_eq "$(audio_length "$folder/mic.wav")" "$(audio_length "$folder/call.wav")" "both sides should be as long as the recording"
call=$(audio_length "$CASE_DIR/call/call.wav")
assert_between "$(audio_length "$folder/call.wav")" "$(echo "$call + 3" | bc)" "$(echo "$call + 6" | bc)"

# Each side has only its own lines, where the dialogue has them.
audio_sync "$folder/mic.wav" "$CASE_DIR/call/timeline.tsv" me > "$CASE_DIR/sync-mic.txt" \
    || { cat "$CASE_DIR/sync-mic.txt"; fail "mic.wav should have your lines, in place, and nothing else"; }
audio_sync "$folder/call.wav" "$CASE_DIR/call/timeline.tsv" call > "$CASE_DIR/sync-call.txt" \
    || { cat "$CASE_DIR/sync-call.txt"; fail "call.wav should have the participant's lines, in place, and nothing else"; }
cat "$CASE_DIR/sync-mic.txt" "$CASE_DIR/sync-call.txt"

wait_log "Notes ready" 60
wait_log "Working audio removed: " 5
[[ -e $folder ]] && fail "the working audio should be gone once the notes are ready"
assert_file "$(ready_notes)"
