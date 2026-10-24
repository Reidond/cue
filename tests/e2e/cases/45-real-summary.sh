#!/bin/bash
# With the real Claude, the Ukrainian test call's notes say «до п'ятниці» and make no remarks about
# the transcript or speech recognition.
source "$(dirname "$0")/../lib.sh"
need_real_claude
need_whisper

cue_defaults speakerName string "Андрій Тест"
cue_defaults autoAnswer bool false
project=$CUE_HOME/Documents/Cue/Звіт
mkdir -p "$project"
cat > "$project/project.json" << 'EOF'
{ "name" : "Звіт", "language" : "uk", "occasion" : "Щотижнева зустріч щодо звіту",
  "namesAndTerms" : "Олена Мулеса, узгодженість даних" }
EOF
dialogue "$FIXTURES/dialogues/deadline-uk.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Звіт CUE_REHEARSE_RECORD=1 \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Notes ready" 300
assert_not_contains "$(session_log)" "Summary failed"

summary=$CASE_DIR/summary.md
summary_of "$(ready_notes)" > "$summary"
cat "$summary"
assert_contains "$summary" "^## "
assert_contains "$summary" "п['’ʼ]ятниц"
assert_not_contains "$summary" "транскрипт|розпізна|розшифров|transcript|recogni|дотатниц" \
    "the summary shouldn't comment on the transcript"
assert_not_contains "$(session_log)" "🧽 Dropped" "Claude itself should keep to the rule; the safety net shouldn't have had to step in"
