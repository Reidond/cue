#!/bin/bash
# A call with one person on the call side keeps the plain participant label: no numbers, and the
# participants are you and «Participant», as before speakers were told apart.
source "$(dirname "$0")/../lib.sh"
need_whisper

cue_defaults speakerName string "Andrii Test"
cue_defaults autoAnswer bool false
mkdir -p "$CUE_HOME/Documents/Cue/Interviews"
echo '{ "name" : "Interviews", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Interviews/project.json"
dialogue "$FIXTURES/dialogues/sync.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Interviews CUE_REHEARSE_RECORD=1 \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Notes ready" 300
assert_contains "$(session_log)" "👥 Finding speakers…$"
assert_contains "$(session_log)" "✅ Speakers: 1 "

notes=$(ready_notes)
assert_contains "$notes" "^participants: Andrii Test, Participant$"
assert_eq "$(grep -c -E '^\*\*[0-9:]+ · Participant\*\*$' "$notes")" 2 "both of the participant's lines keep the plain label"
assert_not_contains "$notes" "Participant [0-9]"
turn_speakers "$notes" "$CASE_DIR/call/timeline.tsv" > "$CASE_DIR/speakers.tsv"
cat "$CASE_DIR/speakers.tsv"
assert_eq "$(awk -F'\t' '$1 == "Daniel" { print $2 }' "$CASE_DIR/speakers.tsv" | sort -u)" "Participant"

# The summary is told there is one other label, which may stand for several people.
if [[ $E2E_CLAUDE == fake ]]; then
    claude_requests summary-system > "$CASE_DIR/summary-system.txt"
    assert_contains "$CASE_DIR/summary-system.txt" "\[Andrii Test\] is the person who recorded the call; the other label is everyone else"
fi
