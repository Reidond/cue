#!/bin/bash
# A Zoom call that isn't in the calendar is offered for recording too (a browser alone isn't);
# if nothing is said, no note is written, and the next Zoom call is offered again.
source "$(dirname "$0")/../lib.sh"

cue_launch CUE_MEETING_TICK=0.5 CUE_MIC_RELEASE=2

mic_apps com.google.Chrome.helper
sleep 2
assert_not_contains "$(session_log)" "🔔" "a browser on the microphone without a meeting isn't a call"

mic_apps com.google.Chrome.helper us.zoom.xos
wait_log "🔔 Record “Zoom call”\?" 10
cue_control notification record
wait_log "📅 Recording “Zoom call” into Meetings" 10

mic_apps
wait_log "📅 Zoom let go of the microphone" 10
wait_log "🔔 Nothing was recorded in “Zoom call”" 10
assert_eq "$(find_notes | wc -l | tr -d ' ')" 0 "no speech, no notes"

mic_apps us.zoom.xos
wait_for "the next Zoom call to be offered" 15 eval '(($(log_count "🔔 Record “Zoom call”") == 2))'
