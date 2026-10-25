#!/bin/bash
# While a new note is processed, its page lists the steps — Saving audio, Improving transcript,
# Writing summary — as they happen; once the notes are ready and nothing failed, the list goes.
source "$(dirname "$0")/../lib.sh"
need_whisper
# A second pass and a summary that take a while, as they do for a long call. (OCR may read
# a step's status icon as a character before its name.)
whisper_cli_spy 8

cue_defaults speakerName string "Andrii Test"
cue_defaults autoAnswer bool false
mkdir -p "$CUE_HOME/Documents/Cue/Interviews"
echo '{ "name" : "Interviews", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Interviews/project.json"
dialogue "$FIXTURES/dialogues/sync.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Interviews CUE_REHEARSE_RECORD=1 CUE_WHISPER_CLI="$CASE_DIR/whisper-cli" FAKE_CLAUDE_SUMMARY_DELAY=20 \
    CUE_SNAPSHOT="$CASE_DIR/cue.png" \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
page=$CASE_DIR/page.txt

# Stop opens the note on the dashboard, with its steps on top of the live transcript.
wait_log "🔁 Improving transcript…" 120
wait_for "the note's steps" 20 _dashboard_shows "^.{0,3}Improving transcript$"
assert_contains "$page" "^.{0,3}Saving audio$"
assert_contains "$page" "^.{0,3}Writing summary$"
assert_contains "$page" "^Transcript$"

wait_log "✍️ Writing summary…" 30
wait_for "the summary step" 20 _dashboard_shows "^.{0,3}Writing summary$"
assert_contains "$page" "^.{0,3}Improving transcript$"

wait_log "Notes ready" 60
_steps_gone() { _dashboard_shows "^Summary$" && ! grep -q -E "^.{0,3}(Improving transcript|Writing summary)$" "$page"; }
wait_for "the steps to leave the page" 20 _steps_gone
assert_contains "$page" "by Friday"
