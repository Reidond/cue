#!/bin/bash
# A note with audio opens with a player on top (play, scrubber, 1×/1.5×/2×), and clicking a
# timestamp in its transcript plays the audio from that moment.
source "$(dirname "$0")/../lib.sh"

# A note as Cue saves it, with the call's audio next to it.
dialogue "$FIXTURES/dialogues/sync.txt" "$CASE_DIR/call"
project=$CUE_HOME/Documents/Cue/Bee\ talk
mkdir -p "$project/Notes"
echo '{ "name" : "Bee talk", "language" : "en" }' > "$project/project.json"
name="2026-10-24 14.05 – Weekly sync about the report"
afconvert -f m4af -d aac -b 32000 "$CASE_DIR/call/call.wav" "$project/Notes/$name.m4a" || fail "couldn't make the audio"
awk -v line="audio: \"$name.m4a\"" '{ print } /^participants: / { print line }' "$FIXTURES/notes/sample.md" > "$project/Notes/$name.md"

dashboard=$CASE_DIR/cue-dashboard.png
text=$CASE_DIR/page.txt
cue_launch CUE_SNAPSHOT="$CASE_DIR/cue.png"
_page_shows() { [[ -s $dashboard ]] && ocr "$dashboard" > "$text" && grep -q -i -E -- "$1" "$text"; }

# The player's position and length; Vision reads the play button as a bullet, × as x (or Cyrillic х).
start='(^|[^0-9:])0:00$'
cue_control page "Bee talk/notes"
wait_for "the note's player" 20 _page_shows "^0:16$"
assert_contains "$text" "^Summary$"
assert_contains "$text" "$start" "the player should start at 0:00"
assert_contains "$text" "^1 ?(×|x|х)$" "the player should offer 1×"
assert_contains "$text" "1[.,]5 ?(×|x|х)" "the player should offer 1.5×"
assert_contains "$text" "(^| )2 ?(×|x|х)$" "the player should offer 2×"
assert_not_contains "$text" "m4a" "the audio file's name belongs in the player, not the note's details"

# Clicking the participant's timestamp (00:00:12) plays from there.
cue_control timestamp 00:00:12
wait_log "Playing $name\.m4a from 0:12 \(player at 12\.0 s\)" 10
wait_for "the player to show 0:12 or later" 10 _page_shows '(^|[^0-9:])0:1[2-6]$'
