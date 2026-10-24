#!/bin/bash
# The summary is asked for with the project's names and terms and occasion, and with an explicit
# rule, and a counter-example, against notes about the transcript or speech recognition.
source "$(dirname "$0")/../lib.sh"
need_whisper
[[ $E2E_CLAUDE == fake ]] || skip "checks what Cue sends the fake claude"

cue_defaults speakerName string "Andrii Test"
cue_defaults autoAnswer bool false
mkdir -p "$CUE_HOME/Documents/Cue/Beekeeping"
cat > "$CUE_HOME/Documents/Cue/Beekeeping/project.json" << 'EOF'
{ "name" : "Beekeeping", "language" : "en", "occasion" : "Weekly sync about the urban beekeeping report",
  "namesAndTerms" : "Olena Mulesa, varroa mites, rooftop apiaries, Київ" }
EOF
dialogue "$FIXTURES/dialogues/sync.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Beekeeping CUE_REHEARSE_RECORD=1 \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Notes ready" 180

prompt=$CASE_DIR/summary-system.txt
claude_requests summary-system > "$prompt"
assert_file "$prompt" "Cue should have asked for a summary"
assert_contains "$prompt" "Names and terms that may come up, spelled the way the user writes them: Olena Mulesa, varroa mites, rooftop apiaries, Київ$"
assert_contains "$prompt" "Context the user gave about their current talk .*: Weekly sync about the urban beekeeping report"
assert_contains "$prompt" "Write about the conversation only, never about the transcript"
assert_contains "$prompt" "not in parentheses"
assert_contains "$prompt" "never write «.*\(у транскрипті — „дотатниці“, ймовірно.*\)» — write «Надіслати звіт до п'ятниці»"
assert_not_contains "$prompt" "calendar event" "a call without a calendar event shouldn't mention one"
