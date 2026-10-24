#!/bin/bash
# A summary that comments on the transcript anyway loses those parenthetical remarks (the words that
# give them away are in the lexicons); the rest of it, other parentheses included, stays as written.
source "$(dirname "$0")/../lib.sh"
need_whisper
[[ $E2E_CLAUDE == fake ]] || skip "needs the fake claude's summary"

cue_defaults speakerName string "Андрій Тест"
cue_defaults autoAnswer bool false
mkdir -p "$CUE_HOME/Documents/Cue/Звіт"
echo '{ "name" : "Звіт", "language" : "uk" }' > "$CUE_HOME/Documents/Cue/Звіт/project.json"
dialogue "$FIXTURES/dialogues/deadline-uk.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Звіт CUE_REHEARSE_RECORD=1 FAKE_CLAUDE_SUMMARY="$FIXTURES/summaries/transcript-remarks.md" \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Notes ready" 180

notes=$(ready_notes)
[[ $(basename "$notes") == *" – Звіт до п'ятниці.md" ]] || fail "the note should be named after the summary: $(basename "$notes")"
summary=$CASE_DIR/summary.md
summary_of "$notes" > "$summary"
assert_not_contains "$summary" "транскрипт|розпізнано|transcript" "the summary shouldn't comment on the transcript"
assert_contains "$summary" "^Учасниця запитала про звіт щодо узгодженості даних\. Звіт майже готовий, його надішлють до п'ятниці\.$"
assert_contains "$summary" "^- Залишилося перевірити таблиці\.$"
assert_contains "$summary" "^- Рівень узгодженості обговорять на наступній зустрічі\.$"
assert_not_contains "$summary" "^- *$|Примітка" "a list item that was only a remark should go"
assert_eq "$(grep -c '^- [^[]' "$summary")" 2 "the two real key points should stay"
# Parentheses that say something about the call stay, and so does a link.
assert_contains "$summary" "^- \[ \] Андрій Тест: надіслати звіт \(до п'ятниці\)$"
assert_contains "$summary" "^- \[ \] Олена: оновити \[таблиці\]\(https://example\.com/tables\) \(за потреби\)$"

# Each dropped remark is in the session log.
assert_eq "$(log_count "🧽 Dropped a remark about the transcript from the summary: ")" 4 "four remarks should be dropped"
assert_contains "$(session_log)" "🧽 Dropped .*: \(у транскрипті — «у згодженості», ймовірно, йдеться про узгодженість\)$"
