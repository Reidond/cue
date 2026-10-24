#!/bin/bash
# Upcoming lists today's and tomorrow's calls with a Meet / Zoom / Teams link from the watched
# calendars, each with the project its notes go to; Settings shows the calendar choices.
source "$(dirname "$0")/../lib.sh"

cat > "$EVENTS" << EOF
[
  { "title": "Design review", "start": "$(minutes_from_now 60)", "end": "$(minutes_from_now 90)", "calendar": "Work",
    "url": "https://meet.google.com/abc-defg-hij", "attendees": ["Olena Mulesa", "Petro Ivanenko"] },
  { "title": "Lunch with Ira", "start": "$(minutes_from_now 90)", "end": "$(minutes_from_now 150)", "calendar": "Work",
    "location": "Café on the corner" },
  { "title": "Teams planning", "start": "$(minutes_from_now 120)", "end": "$(minutes_from_now 180)", "calendar": "Work",
    "notes": "Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0 — agenda to follow" },
  { "title": "Zoom standup", "start": "$(minutes_from_now 1440)", "end": "$(minutes_from_now 1455)", "calendar": "Work",
    "location": "https://us02web.zoom.us/j/123456789?pwd=abc", "recurring": true },
  { "title": "Family call", "start": "$(minutes_from_now 30)", "end": "$(minutes_from_now 60)", "calendar": "Personal",
    "url": "https://meet.google.com/xyz-abcd-efg" },
  { "title": "Old retro", "start": "$(minutes_from_now -2880)", "end": "$(minutes_from_now -2820)", "calendar": "Work",
    "url": "https://meet.google.com/old-retr-ooo" }
]
EOF
cue_defaults unwatchedCalendars array Personal
cue_launch CUE_SNAPSHOT="$CASE_DIR/cue.png" CUE_SHOW_SETTINGS=1
text=$CASE_DIR/page.txt

dashboard_page upcoming "Design review"
assert_contains "$text" "Teams planning"
assert_contains "$text" "Zoom standup"
assert_contains "$text" "^Tomorrow$"
assert_contains "$text" "Google Meet"
assert_contains "$text" "Microsoft Teams"
assert_contains "$text" "Olena Mulesa, Petro Ivanenko"
assert_not_contains "$text" "Lunch with Ira" "an event without a call link is not a call"
assert_not_contains "$text" "Family call" "events in unwatched calendars are left out"
assert_not_contains "$text" "Old retro" "only today's and tomorrow's calls are listed"
# No project is assigned yet, so every call goes to Meetings (which doesn't exist until the first recording).
assert_eq "$(grep -c "Meetings" "$text" | tr -d ' ')" 3 "each of the three calls should show Meetings as its project"
assert_contains "$text" "Cue asks whether to record it"

settings=$CASE_DIR/settings.txt
snapshot_text "$CASE_DIR/cue-settings.png" > "$settings"
assert_contains "$settings" "When a meeting starts"
assert_contains "$settings" "^Ask"
assert_contains "$settings" "Work$"
assert_contains "$settings" "Personal$"
