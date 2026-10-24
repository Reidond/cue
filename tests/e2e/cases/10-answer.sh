#!/bin/bash
# A question asked on the call gets a prepared match and Claude's answer.
source "$(dirname "$0")/../lib.sh"
need_whisper

cue_defaults materials array "$FIXTURES/materials/talk.md"
cue_defaults language string en
cue_defaults autoAnswer bool true
dialogue "$FIXTURES/dialogues/question.txt" "$CASE_DIR/call"
cue_launch CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" \
    FAKE_CLAUDE_ANSWER=$'We studied 48 hives on six rooftops.\n- 48 hives, 6 rooftops\nSource: talk.md'
wait_log "Question:.*hives" 90
wait_log "Answer\*\* \(" 60

log=$(session_log)
assert_contains "$log" "prepared match [0-9]+%"
assert_not_contains "$log" "Answer\*\* .*⚠︎" "the answer should not be an error"
if [[ $E2E_CLAUDE == fake ]]; then
    assert_contains "$log" "We studied 48 hives on six rooftops"
    claude_requests ask > "$CASE_DIR/asked.txt"
    assert_contains "$CASE_DIR/asked.txt" "Question: \[Participant\].*how many hives"
    claude_requests answer-system > "$CASE_DIR/system.txt"
    assert_contains "$CASE_DIR/system.txt" "48 hives on 6 rooftops" "materials belong in Claude's prompt"
else
    assert_contains "$log" "48"
fi
