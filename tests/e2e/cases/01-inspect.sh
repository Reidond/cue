#!/bin/bash
# `Cue --inspect` reads a materials file and finds its prepared answers.
source "$(dirname "$0")/../lib.sh"

out=$CASE_DIR/inspect.txt
cue_cli --inspect "$FIXTURES/materials/talk.md" > "$out" 2>&1 || fail "--inspect exited with $?"
assert_contains "$out" "^talk\.md: "
assert_contains "$out" "Q: How many hives did you study"
assert_contains "$out" "A: We studied 48 hives on 6 rooftops"
assert_contains "$out" "Q: What were the winter losses"
assert_eq "$(grep -c '^  Q' "$out" | tr -d ' ')" 3 "expected 3 prepared answers"
