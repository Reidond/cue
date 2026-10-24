#!/bin/bash
# A call in the calendar plus a browser on the microphone brings one Record prompt; after
# Not now Cue doesn't ask again about that meeting. Calls without a link, or over, don't count.
source "$(dirname "$0")/../lib.sh"

cat > "$EVENTS" << EOF
[
  { "title": "Lunch with Ira", "start": "$(minutes_from_now -10)", "end": "$(minutes_from_now 40)", "location": "Café on the corner" },
  { "title": "Old standup", "start": "$(minutes_from_now -60)", "end": "$(minutes_from_now -1)", "url": "https://meet.google.com/old-stan-dup" },
  { "title": "Weekly design sync", "start": "$(minutes_from_now 3)", "end": "$(minutes_from_now 45)",
    "url": "https://meet.google.com/abc-defg-hij", "attendees": ["Olena Mulesa"] }
]
EOF
cue_launch CUE_MEETING_TICK=0.5 CUE_MIC_RELEASE=2

sleep 2
assert_not_contains "$(session_log)" "🔔" "nothing to ask while no call app uses the microphone"

# Chrome joins the call (its helper process opens the microphone); the meeting starts in 3 minutes.
mic_apps com.google.Chrome.helper
wait_log "🔔 Record “Weekly design sync”\?" 10
sleep 2
assert_eq "$(log_count "🔔 Record")" 1 "one prompt while it waits for an answer"

cue_control notification dismiss
wait_log "🔔 Not now: “Weekly design sync”" 5
sleep 2
# Leaving and rejoining the same meeting doesn't bring the prompt back either.
mic_apps
sleep 3
mic_apps com.google.Chrome.helper
sleep 2
assert_eq "$(log_count "🔔 Record")" 1 "after Not now Cue doesn't ask about the same meeting again"
log=$(session_log)
assert_not_contains "$log" "📅 Recording"
assert_not_contains "$log" "Lunch with Ira|Old standup"
