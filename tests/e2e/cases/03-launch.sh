#!/bin/bash
# Cue launches in the sandbox, reads its materials and shows the overlay.
source "$(dirname "$0")/../lib.sh"

cue_defaults materials array "$FIXTURES/materials/talk.md"
cue_defaults language string en
cue_launch CUE_SNAPSHOT="$CASE_DIR/cue.png"
wait_log "Materials .*talk\.md" 30
text=$CASE_DIR/overlay.txt
snapshot_text "$CASE_DIR/cue.png" > "$text"
assert_contains "$text" "When someone asks a question" "the overlay should show its ready state"
assert_contains "$text" "^No audio$" "with live audio off the status says so"
cue_alive || fail "Cue quit on its own"
