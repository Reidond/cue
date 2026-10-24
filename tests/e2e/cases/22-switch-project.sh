#!/bin/bash
# Switching the project from the overlay changes which materials Cue answers from, and is remembered.
source "$(dirname "$0")/../lib.sh"

cat > "$CASE_DIR/solar.md" << 'EOF'
# Solar panels on the school roof

The school installed 120 panels in 2025; they cover 70 percent of its power.

Q: How many panels are on the roof?
A: There are 120 panels, covering 70 percent of the school's power.
EOF

cue_launch
cue_control new Bees
cue_control add "$FIXTURES/materials/talk.md"
cue_control new Solar
cue_control add "$CASE_DIR/solar.md"
wait_for "both projects' materials" 10 test -f "$CUE_HOME/Documents/Cue/Solar/Materials/solar.md"
test -f "$CUE_HOME/Documents/Cue/Bees/Materials/talk.md" || fail "talk.md should be in Bees"

# The prompt Claude was last started with.
latest_system() { cat "$(ls "$FAKE_CLAUDE_LOG"/*-answer-system.txt | sort | tail -n 1)"; }
latest_system_has() { latest_system | grep -q "$1"; }

cue_control start Bees
wait_log "Materials for Bees .*talk\.md" 30
wait_for "Claude started with the Bees materials" 20 latest_system_has "48 hives"
cue_control ask How many hives did you study?
wait_log "Question:.*How many hives.*prepared match" 20
latest_system > "$CASE_DIR/bees.txt"
assert_contains "$CASE_DIR/bees.txt" "48 hives on 6 rooftops"
assert_not_contains "$CASE_DIR/bees.txt" "120 panels"

cue_control project Solar
wait_log "Project: Solar" 10
wait_log "Materials for Solar .*solar\.md" 30
wait_for "Claude restarted with the Solar materials" 20 latest_system_has "120 panels"
latest_system > "$CASE_DIR/solar-system.txt"
assert_not_contains "$CASE_DIR/solar-system.txt" "48 hives" "the other project's materials must be gone"
cue_control ask How many panels are on the roof?
wait_log "Question:.*How many panels.*prepared match" 20
answered() { (($(grep -c 'Answer\*\* (' "$(session_log)") >= $1)); }
wait_for "the second answer" 30 answered 2

# The next launch is bound to the project used last.
cue_stop
sleep 1  # session logs are named by the second
cue_launch
wait_log "Project: Solar" 10
wait_log "Materials for Solar .*solar\.md" 30
