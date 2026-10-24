#!/bin/bash
# Settings and notes from before projects become the project "My project", once.
source "$(dirname "$0")/../lib.sh"

old_notes=$CUE_HOME/Documents/Cue\ Recordings
mkdir -p "$old_notes"
cp "$FIXTURES/notes/sample.md" "$old_notes/2026-10-20 10.00 – Weekly sync about the report.md"
cue_defaults materials array "$FIXTURES/materials/talk.md" "$CASE_DIR/gone.pdf"
cue_defaults occasion string "Rooftop beekeeping talk at the city council"
cue_defaults language string uk
cue_defaults vocabulary string "Varroa, Kyiv, linden"
cue_launch
wait_log "Moved your settings into the project “My project”: 1 of 2 materials copied, 1 notes moved" 20
wait_log "Materials for My project .*talk\.md" 30

project=$CUE_HOME/Documents/Cue/My\ project
json=$project/project.json
assert_file "$json"
assert_contains "$json" '"name" : "My project"'
assert_contains "$json" '"occasion" : "Rooftop beekeeping talk at the city council"'
assert_contains "$json" '"language" : "uk"'
assert_contains "$json" '"namesAndTerms" : "Varroa, Kyiv, linden"'
assert_contains "$json" '"created" : "20[0-9]{2}-'

cmp -s "$FIXTURES/materials/talk.md" "$project/Materials/talk.md" || fail "talk.md should be copied into Materials/"
[[ -f $FIXTURES/materials/talk.md ]] || fail "the original material must stay where it was"
assert_eq "$(ls "$project/Materials" | wc -l | tr -d ' ')" 1 "only the file that exists is copied"

note=$project/Notes/2026-10-20\ 10.00\ –\ Weekly\ sync\ about\ the\ report.md
assert_file "$note" "the old note should move into Notes/"
[[ ! -e $old_notes ]] || fail "the emptied old recordings folder should be gone"
assert_contains "$note" '^project: "My project"$'
assert_contains "$note" "^title: \"Weekly sync about the report\"$"
assert_contains "$note" "send the report"

# A second launch changes nothing.
cue_stop
sleep 1  # session logs are named by the second
cue_launch
wait_log "Materials for My project .*talk\.md" 30
assert_not_contains "$(session_log)" "Moved your settings"
assert_eq "$(ls "$CUE_HOME/Documents/Cue" | wc -l | tr -d ' ')" 1 "still one project"
assert_eq "$(ls "$project/Materials" | wc -l | tr -d ' ')" 1 "materials are not copied twice"
assert_eq "$(find_notes | wc -l | tr -d ' ')" 1 "still one note"
