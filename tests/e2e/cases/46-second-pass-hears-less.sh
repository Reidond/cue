#!/bin/bash
# A second pass that hears far less than live recognition did (here whisper-cli only gets the first
# second of each side) doesn't replace the live transcript: the note keeps it and says why.
source "$(dirname "$0")/../lib.sh"
need_whisper
need_whisper_cli

cat > "$CASE_DIR/whisper-cli" << SCRIPT
#!/bin/bash
exec "$WHISPER_CLI" "\$@" --duration 1000
SCRIPT
chmod +x "$CASE_DIR/whisper-cli"

cue_defaults speakerName string "Andrii Test"
cue_defaults autoAnswer bool false
mkdir -p "$CUE_HOME/Documents/Cue/Interviews"
echo '{ "name" : "Interviews", "language" : "en" }' > "$CUE_HOME/Documents/Cue/Interviews/project.json"
dialogue "$FIXTURES/dialogues/sync.txt" "$CASE_DIR/call"
cue_launch CUE_PROJECT=Interviews CUE_REHEARSE_RECORD=1 CUE_WHISPER_CLI="$CASE_DIR/whisper-cli" \
    CUE_REHEARSE_PARTICIPANT="$CASE_DIR/call/call.wav" CUE_REHEARSE_ME="$CASE_DIR/call/me.wav"
wait_log "Notes ready" 180

log=$(session_log)
assert_contains "$log" "⚠︎ Couldn't improve the transcript: it heard much less than live recognition on (your side|the call side) — the live transcript is kept$"
assert_not_contains "$log" "Transcript improved"

# Every line live recognition heard is in the note, as it heard it.
notes=$(ready_notes)
assert_file "$notes"
grep -o -E '\*\*\[(Participant|Andrii Test)\]\*\* .*' "$log" | sed -E 's/^\*\*\[[^]]+\]\*\* //' > "$CASE_DIR/live.txt"
assert_eq "$(wc -l < "$CASE_DIR/live.txt" | tr -d ' ')" 4 "live recognition should have heard the four lines"
while IFS= read -r line; do
    grep -q -F -- "$line" "$notes" || fail "the note should keep the live line: $line"
done < "$CASE_DIR/live.txt"
assert_contains "$notes" "^## Summary"
