#!/bin/bash
# Answering Record records the meeting into its project, named after the event with its attendees;
# once the call app has let go of the microphone for the release window, Cue stops and writes the notes.
source "$(dirname "$0")/../lib.sh"
need_whisper

mkdir -p "$CUE_HOME/Documents/Cue/Research"
echo '{ "name" : "Research", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Research/project.json"
cat > "$EVENTS" << EOF
[
  { "id": "sync-today", "series": "design-sync", "title": "Weekly design sync", "recurring": true,
    "start": "$(minutes_from_now -2)", "end": "$(minutes_from_now 30)", "calendar": "Work",
    "url": "https://meet.google.com/abc-defg-hij", "attendees": ["Olena Mulesa", "Petro Ivanenko"] }
]
EOF
cue_defaults speakerName string "Andrii Test"
cue_defaults autoAnswer bool false
dialogue "$FIXTURES/dialogues/meeting.txt" "$CASE_DIR/call"
cue_launch CUE_MEETING_TICK=0.5 CUE_MIC_RELEASE=4 \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"

cue_control "assign Weekly design sync | Research"
mic_apps com.google.Chrome.helper
wait_log "🔔 Record “Weekly design sync”\?" 10
cue_control notification record
wait_log "📅 Recording “Weekly design sync” into Research" 10

wait_log "\*\*\[Participant\]\*\* .*next week" 120
assert_not_contains "$(session_log)" "let go of the microphone" "the call is still on"
# Chrome leaves the call.
mic_apps
released=$(date +%s)
wait_log "📅 Google Chrome let go of the microphone — stopping the recording" 20
waited=$(($(date +%s) - released))
((waited >= 3)) || fail "the recording stopped ${waited}s after Chrome let go; the window is 4s"
wait_log "Transcript saved: .*/Documents/Cue/Research/Notes/[0-9 .-]+ – Weekly design sync\.md" 30
wait_log "Notes ready" 60
wait_log "🔔 Notes from “Weekly design sync” are ready" 10

notes=$(ready_notes)
assert_file "$notes"
assert_eq "$(find_notes | wc -l | tr -d ' ')" 1 "expected exactly one notes file"
assert_contains "$notes" '^title: "Weekly design sync"$'
assert_contains "$notes" '^event: "Weekly design sync"$'
assert_contains "$notes" '^attendees: \["Olena Mulesa", "Petro Ivanenko"\]$'
assert_contains "$notes" '^project: "Research"$'
assert_contains "$notes" "^# Weekly design sync$"
assert_contains "$notes" "onboarding screens"
assert_contains "$notes" "Thursday"
assert_contains "$notes" "^## Summary"

# The note's header lists who was invited.
cue_cli --render "$notes" "$CASE_DIR/notes.png" || fail "--render exited with $?"
ocr "$CASE_DIR/notes.png" > "$CASE_DIR/notes.txt"
assert_contains "$CASE_DIR/notes.txt" "Olena Mulesa, Petro Ivanenko"
assert_not_contains "$CASE_DIR/notes.txt" '\["' "the attendees list is shown as names"

claude_requests summary-system > "$CASE_DIR/summary-system.txt"
assert_contains "$CASE_DIR/summary-system.txt" "calendar event “Weekly design sync”"
assert_contains "$CASE_DIR/summary-system.txt" "Invited: Olena Mulesa, Petro Ivanenko"
