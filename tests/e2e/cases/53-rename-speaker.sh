#!/bin/bash
# Renaming a speaker on the note's page (clicking their name) renames them throughout the note: the
# transcript, the summary, the title (and so the file and its audio) and the participants, as whole
# words only; the others keep their labels.
source "$(dirname "$0")/../lib.sh"
need_whisper
[[ $E2E_CLAUDE == fake ]] || skip "needs the fake claude's summary"

cue_defaults speakerName string "Andrii Test"
cue_defaults autoAnswer bool false
mkdir -p "$CUE_HOME/Documents/Cue/Library"
echo '{ "name" : "Library", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Library/project.json"
dialogue "$FIXTURES/dialogues/two-voices.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Library CUE_REHEARSE_RECORD=1 FAKE_CLAUDE_SUMMARY="$FIXTURES/summaries/speaker-rename.md" \
    CUE_SNAPSHOT="$CASE_DIR/cue.png" \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Notes ready" 300
wait_log "✅ Speakers: 2 " 1
before=$(ready_notes)
[[ $(basename "$before") == *" – Reading room plan with Participant 1.md" ]] || fail "the note should be named after the summary: $(basename "$before")"

dashboard_page "Library/notes" "Participant 1 opened the call"
cue_control "rename Participant 1 | Petro Ivanenko"
wait_log "✏️ Renamed “Participant 1” to “Petro Ivanenko” in Reading room plan with Participant 1$" 10

assert_eq "$(find_notes | wc -l | tr -d ' ')" 1 "the note is renamed, not copied"
notes=$(find_notes)
[[ $(basename "$notes") == *" – Reading room plan with Petro Ivanenko.md" ]] || fail "the note should take its new title: $(basename "$notes")"
assert_file "${notes%.md}.m4a" "the audio should be renamed with the note"
assert_eq "$(find "$CUE_HOME/Documents" -name '*.m4a' | wc -l | tr -d ' ')" 1 "expected exactly one audio file"
grep -q -F -x "audio: \"$(basename "${notes%.md}.m4a")\"" "$notes" || fail "the front matter should name the renamed audio"
assert_contains "$notes" '^title: "Reading room plan with Petro Ivanenko"$'
assert_contains "$notes" "^# Reading room plan with Petro Ivanenko$"
assert_contains "$notes" "^participants: Andrii Test, Petro Ivanenko, Participant 2$"

# The summary: every mention of the name, and nothing that only looks like it.
summary_of "$notes" > "$CASE_DIR/summary.md"
assert_contains "$CASE_DIR/summary.md" "^Petro Ivanenko opened the call about the new reading room\. Participant 2 summed up"
assert_contains "$CASE_DIR/summary.md" "Petro Ivanenko's next meeting is on Monday\.$"
assert_contains "$CASE_DIR/summary.md" "^- Participants asked for more quiet desks\.$"
assert_contains "$CASE_DIR/summary.md" "^- \[ \] Participant 2: send the survey summary"
assert_not_contains "$notes" "Participant 1([^0-9]|$)" "no mention of the old name should be left"

# The transcript: Daniel's lines are Petro Ivanenko's now, Karen's still Participant 2's.
turn_speakers "$notes" "$CASE_DIR/call/timeline.tsv" > "$CASE_DIR/speakers.tsv"
cat "$CASE_DIR/speakers.tsv"
labels() { awk -F'\t' -v voice="$1" '$1 == voice { print $2 }' "$CASE_DIR/speakers.tsv" | sort -u | paste -s -d, -; }
assert_eq "$(labels Daniel)" "Petro Ivanenko"
assert_eq "$(labels Karen)" "Participant 2"
assert_eq "$(labels Samantha)" "Andrii Test"

# The open note shows the new name.
wait_for "the page to show the new name" 20 _dashboard_shows "^Petro Ivanenko opened the call"
assert_contains "$CASE_DIR/page.txt" "^Petro Ivanenko( 00:[0-9:]+)?$"
