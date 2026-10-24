#!/bin/bash
# After the second pass, Cue tells the voices on the call side apart: a call with three people on
# it comes out with three participants plus you, every line under the label of the voice that said
# it, consecutive lines of one voice as one turn; the participants and the summary prompt list them.
source "$(dirname "$0")/../lib.sh"
need_whisper

cue_defaults speakerName string "Andrii Test"
cue_defaults autoAnswer bool false
mkdir -p "$CUE_HOME/Documents/Cue/Library"
echo '{ "name" : "Library", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Library/project.json"
dialogue "$FIXTURES/dialogues/three-voices.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Library CUE_REHEARSE_RECORD=1 \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Notes ready" 300

# The steps, in order: speakers are found after the second pass and before the summary.
log=$(session_log)
steps=$(grep -o -E "Improving transcript…|Transcript improved|Finding speakers…|Speakers: [0-9]+|Writing summary…|Notes ready" "$log" | paste -s -d, -)
assert_eq "$steps" "Improving transcript…,Transcript improved,Finding speakers…,Speakers: 3,Writing summary…,Notes ready" \
    "the note should go through its steps in order: $steps"

notes=$(ready_notes)
assert_file "$notes"
assert_contains "$notes" "^participants: Andrii Test, Participant 1, Participant 2, Participant 3$"
assert_not_contains "$notes" "· Participant\*\*$" "every call-side turn should have its speaker's number"

# Each line of the dialogue is under its voice's label: one label per voice, a different one for each.
turn_speakers "$notes" "$CASE_DIR/call/timeline.tsv" > "$CASE_DIR/speakers.tsv"
cat "$CASE_DIR/speakers.tsv"
assert_not_contains "$CASE_DIR/speakers.tsv" "\?$" "every line should start a turn of its own"
labels() { awk -F'\t' -v voice="$1" '$1 == voice { print $2 }' "$CASE_DIR/speakers.tsv" | sort -u | paste -s -d, -; }
assert_eq "$(labels Samantha)" "Andrii Test" "your lines should be yours"
assert_eq "$(labels Daniel)" "Participant 1" "Daniel speaks first, so he is Participant 1 on all his lines"
assert_eq "$(labels Karen)" "Participant 2" "Karen should be Participant 2 on all her lines"
assert_eq "$(labels Fred)" "Participant 3" "Fred should be Participant 3 on all his lines"
assert_eq "$(grep -c -E '^\*\*[0-9]{2}:[0-9]{2}:[0-9]{2} · ' "$notes")" 11 "each line of the call is its own turn"

# The summary is written from the labelled transcript, and asked for names where the call makes them clear.
if [[ $E2E_CLAUDE == fake ]]; then
    claude_requests summary-input > "$CASE_DIR/summary-input.txt"
    assert_contains "$CASE_DIR/summary-input.txt" "\[Participant 2\] .*visitor survey"
    assert_contains "$CASE_DIR/summary-input.txt" "\[Participant 3\] .*budget"
    claude_requests summary-system > "$CASE_DIR/summary-system.txt"
    assert_contains "$CASE_DIR/summary-system.txt" "\[Andrii Test\] is the person who recorded the call; \[Participant 1\], \[Participant 2\] and \[Participant 3\] are the other people on the call, told apart by their voices"
    assert_contains "$CASE_DIR/summary-system.txt" "<!-- speaker: Participant 1 = Olena Mulesa -->"
fi
