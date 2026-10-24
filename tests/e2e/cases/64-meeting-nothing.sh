#!/bin/bash
# With "Do nothing" Cue lists the call but never asks or records, even with call apps on the microphone.
source "$(dirname "$0")/../lib.sh"

cat > "$EVENTS" << EOF
[
  { "title": "Weekly design sync", "start": "$(minutes_from_now -2)", "end": "$(minutes_from_now 30)",
    "url": "https://meet.google.com/abc-defg-hij" }
]
EOF
cue_defaults meetingAction string nothing
mic_apps com.google.Chrome.helper us.zoom.xos
cue_launch CUE_MEETING_TICK=0.5 CUE_MIC_RELEASE=2 CUE_SNAPSHOT="$CASE_DIR/cue.png"

dashboard_page upcoming "Weekly design sync"
assert_contains "$CASE_DIR/page.txt" "doesn.t record calls when they start"
sleep 3
log=$(session_log)
assert_not_contains "$log" "🔔"
assert_not_contains "$log" "📅 Recording"
