#!/bin/bash
# After Stop, whisper-cli reads each side's whole recording again, at background priority, with
# beam search and the project's language, occasion and names and terms; its transcript replaces the
# live one in the note, both sides merged by time, before the summary is written.
source "$(dirname "$0")/../lib.sh"
need_whisper
whisper_cli_spy

cue_defaults speakerName string "Андрій Тест"
cue_defaults autoAnswer bool false
project=$CUE_HOME/Documents/Cue/Звіт
mkdir -p "$project"
cat > "$project/project.json" << 'EOF'
{ "name" : "Звіт", "language" : "uk", "occasion" : "Щотижнева зустріч щодо звіту",
  "namesAndTerms" : "Олена Мулеса, узгодженість даних, Київ" }
EOF
dialogue "$FIXTURES/dialogues/deadline-uk.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Звіт CUE_REHEARSE_RECORD=1 CUE_WHISPER_CLI="$CASE_DIR/whisper-cli" \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Notes ready" 180

# The steps, in order: the live transcript and the audio first, then the second pass, then the summary.
steps=$(grep -o -E "Transcript saved|Audio saved|Working audio:|Improving transcript…|Transcript improved|Writing summary…|Notes ready|Working audio removed" \
    "$(session_log)" | paste -s -d, -)
assert_eq "$steps" "Transcript saved,Audio saved,Working audio:,Improving transcript…,Transcript improved,Writing summary…,Notes ready,Working audio removed" \
    "the note should go through its steps in order: $steps"
wait_log "✅ Transcript improved: [0-9]+ segments \([0-9.]+ s for 0:[0-9]{2} of audio\)" 1

# The second pass's words («п'ятниці» with its apostrophe), each line at the moment it was said in
# the recording (timeline: 0.50 call, 6.63 me, 12.88 call, 17.28 me, 20.66 call), both speakers.
notes=$(ready_notes)
assert_file "$notes"
assert_contains "$notes" "^## Транскрипт$"
assert_contains "$notes" "до п['’ʼ]ятниці"
assert_contains "$notes" "узгодженості даних"
assert_contains "$notes" "^\*\*00:00:00 · Учасник\*\*$"
assert_contains "$notes" "^\*\*00:00:06 · Андрій Тест\*\*$"
assert_contains "$notes" "^\*\*00:00:12 · Учасник\*\*$"
assert_contains "$notes" "^\*\*00:00:17 · Андрій Тест\*\*$"
assert_contains "$notes" "^\*\*00:00:20 · Учасник\*\*$"
assert_eq "$(grep -c -E '^\*\*[0-9]{2}:[0-9]{2}:[0-9]{2} · ' "$notes")" 5 "each line of the call should be its own turn"

# How whisper-cli ran: both sides of the working audio, beam search 5, the project's language,
# its occasion and names and terms as the prompt (for every window), full JSON, low priority.
args=$CASE_DIR/whisper-args.txt
assert_file "$args" "Cue should have run whisper-cli"
argument() { grep -A1 -x -- "$1" "$args" | sed -n 2p; }
assert_eq "$(argument -bs)" 5 "whisper-cli should use beam search 5: $(paste -s -d' ' "$args")"
assert_eq "$(argument -l)" uk "whisper-cli should listen for the project's language"
grep -q -x -- "-ojf" "$args" || fail "full JSON output: $(paste -s -d' ' "$args")"
grep -q -x -- "--carry-initial-prompt" "$args" || fail "the prompt should apply to every window"
assert_contains "$args" "^Щотижнева зустріч щодо звіту\. Олена Мулеса, узгодженість даних, Київ$"
assert_contains "$args" "/recordings/[0-9T-]+Z/mic\.wav$"
assert_contains "$args" "/recordings/[0-9T-]+Z/call\.wav$"
assert_eq "$(cat "$CASE_DIR/whisper-priority.txt")" 4 "whisper-cli should run at background priority (4)"

# The summary is written from the improved transcript.
if [[ $E2E_CLAUDE == fake ]]; then
    claude_requests summary-input > "$CASE_DIR/summary-input.txt"
    assert_contains "$CASE_DIR/summary-input.txt" "\[Андрій Тест\] .*до п['’ʼ]ятниці"
fi
