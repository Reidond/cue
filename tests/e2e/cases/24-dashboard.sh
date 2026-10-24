#!/bin/bash
# The dashboard shows Home, a project's page, its prepared answers and its notes.
source "$(dirname "$0")/../lib.sh"

png=$CASE_DIR/cue.png
dashboard=$CASE_DIR/cue-dashboard.png
text=$CASE_DIR/page.txt
cue_launch CUE_SNAPSHOT="$png"

# page PAGE MARKER — shows a dashboard page and waits until its snapshot shows MARKER;
# the page's text is then in $text.
page() {
    cue_control page "$1"
    wait_for "the $1 page to show /$2/" 20 _page_shows "$2"
}
_page_shows() { [[ -s $dashboard ]] && ocr "$dashboard" > "$text" && grep -q -i -E -- "$1" "$text"; }

page home "Create Your First Project"
assert_contains "$text" "^Home$"
assert_contains "$text" "Upcoming$"
assert_contains "$text" "^Projects$"
assert_contains "$text" "New Project"

cue_control new Bee talk
cue_control add "$FIXTURES/materials/talk.md"
notes=$CUE_HOME/Documents/Cue/Bee\ talk/Notes
wait_for "the project" 10 test -d "$notes"
cp "$FIXTURES/notes/sample.md" "$notes/2026-10-20 10.00 – Weekly sync about the report.md"

page "Bee talk" "3 prepared answers"
assert_eq "$(grep -c "Bee talk$" "$text")" 2 "the project should be in the sidebar and the page's header"
assert_contains "$text" "Start Cue"
assert_contains "$text" "About the Talk"
assert_contains "$text" "^Materials$"
assert_contains "$text" "talk\.md"
assert_contains "$text" "1 file"

page "Bee talk/answers" "How many hives did you study"
assert_contains "$text" "We studied 48 hives on 6 rooftops"
assert_contains "$text" "What were the winter losses"

page "Bee talk/notes" "Weekly sync about the report"
assert_contains "$text" "^Summary$"
assert_contains "$text" "send the report"

page home "Recent Notes"
assert_contains "$text" "Weekly sync about the report"
assert_not_contains "$text" "Create Your First Project"

page upcoming "No Upcoming Calls"

# The overlay names the project it answers from.
_overlay_shows() { ocr "$png" | grep -q "$1"; }
cue_control start Bee talk
wait_log "Materials for Bee talk" 30
wait_for "the overlay to name the project" 10 _overlay_shows "Bee talk"
