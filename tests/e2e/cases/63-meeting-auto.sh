#!/bin/bash
# With "Record automatically" a meeting is recorded without a prompt, into Meetings (created for it).
source "$(dirname "$0")/../lib.sh"
need_whisper

# The talk Cue is bound to, in English; meetings go elsewhere.
mkdir -p "$CUE_HOME/Documents/Cue/Talk"
echo '{ "name" : "Talk", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Talk/project.json"
cat > "$EVENTS" << EOF
[
  { "title": "Product demo", "start": "$(minutes_from_now -1)", "end": "$(minutes_from_now 30)",
    "location": "https://us02web.zoom.us/j/123456789?pwd=abc", "attendees": ["Mia Chen"] }
]
EOF
cue_defaults meetingAction string record
cue_defaults autoAnswer bool false
mic_apps us.zoom.xos
dialogue "$FIXTURES/dialogues/meeting.txt" "$CASE_DIR/call"
cue_launch CUE_MEETING_TICK=0.5 CUE_MIC_RELEASE=3 \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"

wait_log "📅 Recording “Product demo” into Meetings" 10
assert_file "$CUE_HOME/Documents/Cue/Meetings/project.json" "Meetings is created for the first meeting recording"
wait_log "\*\*\[Participant\]\*\* .*next week" 120
mic_apps
wait_log "📅 Zoom let go of the microphone" 20
wait_log "Transcript saved: .*/Documents/Cue/Meetings/Notes/[0-9 .-]+ – Product demo\.md" 30
wait_log "🔔 Notes from “Product demo” are ready" 60
assert_not_contains "$(session_log)" "🔔 Record" "Record automatically doesn't ask"

notes=$(ready_notes)
assert_contains "$notes" '^title: "Product demo"$'
assert_contains "$notes" '^project: "Meetings"$'
assert_contains "$notes" '^attendees: \["Mia Chen"\]$'
assert_contains "$notes" "onboarding screens"
assert_eq "$(ls "$CUE_HOME/Documents/Cue/Talk/Notes" 2> /dev/null | wc -l | tr -d ' ')" 0 "the active project gets nothing"
