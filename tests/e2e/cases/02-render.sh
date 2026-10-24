#!/bin/bash
# `Cue --render` draws a notes file the way the app shows it.
source "$(dirname "$0")/../lib.sh"

png=$CASE_DIR/notes.png
cue_cli --render "$FIXTURES/notes/sample.md" "$png" || fail "--render exited with $?"
assert_file "$png"
text=$CASE_DIR/notes.txt
ocr "$png" > "$text"
assert_contains "$text" "Weekly sync about the report"
assert_contains "$text" "^Summary$"
assert_contains "$text" "send the report"
assert_contains "$text" "^Transcript$"
assert_contains "$text" "00:00:12"
assert_not_contains "$text" "transcript -->" "the transcript marker must not be drawn"
