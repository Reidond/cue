#!/bin/bash
# A recorded call keeps its audio next to the notes: AAC as long as the call, both sides in sync,
# named in the front matter and renamed with the notes after the summary.
source "$(dirname "$0")/../lib.sh"
need_whisper

cue_defaults speakerName string "Andrii Test"
mkdir -p "$CUE_HOME/Documents/Cue/Interviews"
echo '{ "name" : "Interviews", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Interviews/project.json"
dialogue "$FIXTURES/dialogues/sync.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Interviews CUE_REHEARSE_RECORD=1 \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Transcript saved" 120
wait_log "Audio saved: .*/Documents/Cue/Interviews/Notes/.*\.m4a \([0-9]+:[0-9]{2}\)" 10
wait_log "Notes ready" 180
steps=$(grep -o -E "Transcript saved|Audio saved|Notes ready" "$(session_log)" | paste -s -d, -)
assert_eq "$steps" "Transcript saved,Audio saved,Notes ready" "the audio should be saved after the transcript and before the notes are ready: $steps"

notes=$(ready_notes)
audio=${notes%.md}.m4a
assert_file "$audio" "the audio should be next to the notes, named like them: $audio"
assert_eq "$(find "$CUE_HOME/Documents" -name '*.m4a' | wc -l | tr -d ' ')" 1 "expected exactly one audio file"
grep -q -F -x "audio: \"$(basename "$audio")\"" "$notes" || { head -n 12 "$notes"; fail "the front matter should name the audio"; }
if [[ $E2E_CLAUDE == fake ]]; then
    [[ $(basename "$audio") == *" – E2E rehearsal notes.m4a" ]] || fail "the audio should be renamed with the notes: $(basename "$audio")"
fi

# Playable AAC, 16 kHz mono, as long as the recording: the call, the rehearsal's 3 s of
# trailing silence and the second before it stops.
afinfo "$audio" > "$CASE_DIR/afinfo.txt" 2>&1 || { cat "$CASE_DIR/afinfo.txt"; fail "afinfo can't read the audio"; }
assert_contains "$CASE_DIR/afinfo.txt" "File type ID: +m4af"
assert_contains "$CASE_DIR/afinfo.txt" "1 ch, +16000 Hz, aac"
call=$(audio_length "$CASE_DIR/call/call.wav")
assert_between "$(audio_length "$audio")" "$(echo "$call + 3" | bc)" "$(echo "$call + 6" | bc)" \
    "the audio should last the recording (call ${call} s + 4 s), not $(audio_length "$audio") s"

# Both sides where the dialogue has them, silence in between.
audio_sync "$audio" "$CASE_DIR/call/timeline.tsv" > "$CASE_DIR/sync.txt" || { cat "$CASE_DIR/sync.txt"; fail "the two sides should be in sync"; }
cat "$CASE_DIR/sync.txt"

# The transcript's timestamps are times in the audio (timeline: 0.50 call, 5.35 me, 9.24 call, 12.48 me).
assert_contains "$notes" "^\*\*00:00:00 · Participant\*\*$"
assert_contains "$notes" "^\*\*00:00:05 · Andrii Test\*\*$"
assert_contains "$notes" "^\*\*00:00:09 · Participant\*\*$"
assert_contains "$notes" "^\*\*00:00:12 · Andrii Test\*\*$"
