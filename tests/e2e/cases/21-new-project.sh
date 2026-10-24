#!/bin/bash
# A new user creates a project, drops a file on it, starts Cue and gets an answer from it.
source "$(dirname "$0")/../lib.sh"

cue_launch FAKE_CLAUDE_ANSWER=$'We studied 48 hives on six rooftops.\n- 48 hives, 6 rooftops\nSource: talk.md'
assert_not_contains "$(session_log)" "Moved your settings" "a new user has nothing to move"
[[ ! -e $CUE_HOME/Documents/Cue/My\ project ]] || fail "no project should exist before one is created"

cue_control new Bee talk
project=$CUE_HOME/Documents/Cue/Bee\ talk
wait_for "the project folder" 10 test -f "$project/project.json"
assert_contains "$project/project.json" '"name" : "Bee talk"'
[[ -d $project/Materials && -d $project/Notes ]] || fail "a project has Materials/ and Notes/"

cue_control add "$FIXTURES/materials/talk.md"
wait_for "the copied material" 10 test -f "$project/Materials/talk.md"
cmp -s "$FIXTURES/materials/talk.md" "$project/Materials/talk.md" || fail "the material should be an exact copy"

cue_control start Bee talk
wait_log "Project: Bee talk" 10
wait_log "Materials for Bee talk .*talk\.md" 30
assert_contains "$project/project.json" '"lastUsed" : "20[0-9]{2}-'

cue_control ask How many hives did you study?
wait_log "Question:.*How many hives" 20
wait_log "Answer\*\* \(" 30
log=$(session_log)
assert_contains "$log" "Question:.*How many hives.*prepared match [0-9]+%"
assert_contains "$log" "We studied 48 hives on six rooftops"
claude_requests answer-system > "$CASE_DIR/system.txt"
assert_contains "$CASE_DIR/system.txt" "48 hives on 6 rooftops" "the project's materials belong in Claude's prompt"
claude_requests ask > "$CASE_DIR/asked.txt"
assert_contains "$CASE_DIR/asked.txt" "How many hives did you study"
