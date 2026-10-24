#!/bin/bash
# The project picked for a recurring meeting on Upcoming is remembered for its next occurrence, after relaunch.
source "$(dirname "$0")/../lib.sh"

mkdir -p "$CUE_HOME/Documents/Cue/Research"
echo '{ "name" : "Research", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Research/project.json"
text=$CASE_DIR/page.txt

cat > "$EVENTS" << EOF
[
  { "id": "weekly-1", "series": "weekly-sync", "title": "Weekly sync", "recurring": true,
    "start": "$(minutes_from_now 30)", "end": "$(minutes_from_now 60)", "url": "https://meet.google.com/abc-defg-hij" },
  { "title": "Board meeting", "start": "$(minutes_from_now 90)", "end": "$(minutes_from_now 120)",
    "url": "https://acme.webex.com/meet/board" }
]
EOF
cue_launch CUE_SNAPSHOT="$CASE_DIR/cue.png"
dashboard_page upcoming "Board meeting"
assert_eq "$(grep -c "Meetings" "$text" | tr -d ' ')" 2 "both calls go to Meetings at first"
cue_control "assign Weekly sync | Research"
# The sidebar lists Research; the meeting's picker shows it too.
wait_for "Weekly sync to go to Research" 20 eval '_dashboard_shows "Board meeting" && (($(grep -c "Research" "$text") == 2))'
assert_eq "$(grep -c "Meetings" "$text" | tr -d ' ')" 1 "Board meeting still goes to Meetings"

cue_stop
sleep 1  # session logs are named by the second
# The next occurrence of the series (another id, the same series), and a new one-off call.
cat > "$EVENTS" << EOF
[
  { "id": "weekly-2", "series": "weekly-sync", "title": "Weekly sync", "recurring": true,
    "start": "$(minutes_from_now 20)", "end": "$(minutes_from_now 40)", "url": "https://meet.google.com/abc-defg-hij" },
  { "title": "Kickoff", "start": "$(minutes_from_now 50)", "end": "$(minutes_from_now 80)",
    "url": "https://meet.google.com/kic-koff-now" }
]
EOF
cue_launch CUE_SNAPSHOT="$CASE_DIR/cue.png"
dashboard_page upcoming "Kickoff"
assert_contains "$text" "Weekly sync"
assert_eq "$(grep -c "Research" "$text" | tr -d ' ')" 2 "the next Weekly sync should still go to Research"
assert_eq "$(grep -c "Meetings" "$text" | tr -d ' ')" 1 "a new call goes to Meetings"
