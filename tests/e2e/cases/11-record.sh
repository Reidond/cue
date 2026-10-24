#!/bin/bash
# A two-sided rehearsal is recorded into notes with both sides, a summary and a title.
source "$(dirname "$0")/../lib.sh"
need_whisper

cue_defaults materials array "$FIXTURES/materials/talk.md"
cue_defaults language string en
cue_defaults speakerName string "Andrii Test"
cue_defaults autoAnswer bool false
dialogue "$FIXTURES/dialogues/sync.txt" "$CASE_DIR/call"
cue_launch CUE_REHEARSE_RECORD=1 CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Transcript saved" 120
wait_log "Notes ready" 180

notes=$(ready_notes)
assert_file "$notes"
assert_eq "$(find_notes | wc -l | tr -d ' ')" 1 "expected exactly one notes file"
assert_contains "$notes" "^## Transcript"
assert_contains "$notes" "^\*\*00:00:[0-9]{2} · Participant\*\*"
assert_contains "$notes" "^\*\*00:00:[0-9]{2} · Andrii Test\*\*"
assert_contains "$notes" "bee ?keeping report"
assert_contains "$notes" "by Friday"
assert_contains "$notes" "^## Summary"
assert_not_contains "$notes" "^_…_$" "the summary placeholder should be replaced"
if [[ $E2E_CLAUDE == fake ]]; then
    assert_contains "$notes" '^title: "E2E rehearsal notes"'
    [[ $(basename "$notes") == *" – E2E rehearsal notes.md" ]] || fail "the file should be renamed after the summary's title: $(basename "$notes")"
    claude_requests summary-system > "$CASE_DIR/summary-system.txt"
    assert_contains "$CASE_DIR/summary-system.txt" "\[Andrii Test\] is the person who recorded the call"
    claude_requests summary-input > "$CASE_DIR/summary-input.txt"
    assert_contains "$CASE_DIR/summary-input.txt" "\[Participant\].*report"
fi
