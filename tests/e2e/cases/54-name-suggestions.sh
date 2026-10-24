#!/bin/bash
# The summary may say who a participant is (they are thanked by name): its suggestion lines are kept
# out of the notes and show on the note's page as a chip, «Participant 2 → Olena Mulesa?», whose
# Apply renames them throughout the note. Suggestions for labels that aren't the call's are ignored.
source "$(dirname "$0")/../lib.sh"
need_whisper
[[ $E2E_CLAUDE == fake ]] || skip "needs the fake claude's summary"

cue_defaults speakerName string "Andrii Test"
cue_defaults autoAnswer bool false
mkdir -p "$CUE_HOME/Documents/Cue/Library"
echo '{ "name" : "Library", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Library/project.json"
dialogue "$FIXTURES/dialogues/two-voices.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Library CUE_REHEARSE_RECORD=1 FAKE_CLAUDE_SUMMARY="$FIXTURES/summaries/speaker-names.md" \
    CUE_SNAPSHOT="$CASE_DIR/cue.png" \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Notes ready" 300
wait_log "✅ Speakers: 2 " 1
assert_contains "$(session_log)" "💡 Suggested name: Participant 2 → Olena Mulesa$"
assert_eq "$(log_count "💡 Suggested name")" 1 "only the call's own labels get suggestions"

# The suggestion is in the front matter, not in the notes.
notes=$(ready_notes)
assert_contains "$notes" '^suggestions: \{"Participant 2": "Olena Mulesa"\}$'
assert_not_contains "$notes" "<!-- speaker" "the suggestion lines should be kept out of the notes"
assert_contains "$notes" "^participants: Andrii Test, Participant 1, Participant 2$"

# Its chip, with Apply, on the note's page; the front matter row doesn't show it.
page=$CASE_DIR/page.txt
dashboard_page "Library/notes" "Participant 2 → Olena Mulesa\?"
assert_contains "$page" "Apply"
assert_eq "$(grep -c "Olena Mulesa" "$page")" 1 "only the chip should name Olena Mulesa: $(grep "Olena Mulesa" "$page")"

cue_control apply Participant 2
wait_log "✏️ Renamed “Participant 2” to “Olena Mulesa”" 10
notes=$(find_notes)
assert_contains "$notes" "^participants: Andrii Test, Participant 1, Olena Mulesa$"
assert_not_contains "$notes" "^suggestions:" "an applied suggestion goes"
assert_not_contains "$notes" "Participant 2" "Olena Mulesa should replace the label everywhere"
summary_of "$notes" > "$CASE_DIR/summary.md"
assert_contains "$CASE_DIR/summary.md" "and Olena Mulesa summed up the visitor survey\.$"
assert_contains "$CASE_DIR/summary.md" "^- \[ \] Olena Mulesa: send the survey summary"
turn_speakers "$notes" "$CASE_DIR/call/timeline.tsv" > "$CASE_DIR/speakers.tsv"
assert_eq "$(awk -F'\t' '$1 == "Karen" { print $2 }' "$CASE_DIR/speakers.tsv" | sort -u)" "Olena Mulesa"

# The chip is gone and the note names her.
_applied() { _dashboard_shows "Olena Mulesa: send the survey summary" && ! grep -q "→ Olena" "$page"; }
wait_for "the chip to go" 20 _applied
assert_not_contains "$page" "Apply"
