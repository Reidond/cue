#!/bin/bash
# Home's checklist has the speaker models, like the speech model: their download size while they are
# missing, and Download, which fetches them from Hugging Face with progress; then the row is done.
source "$(dirname "$0")/../lib.sh"
curl -s -I -m 10 https://huggingface.co > /dev/null || skip "Hugging Face can't be reached"

models=$CASE_DIR/speaker-models
mkdir -p "$models"
cue_launch CUE_SPEAKER_MODELS="$models" CUE_SNAPSHOT="$CASE_DIR/cue.png"
page=$CASE_DIR/page.txt

dashboard_page home "Speaker models$"
assert_contains "$page" "^Finish Setting Up$"
assert_contains "$page" "^[0-9]+ MB download, stays on this Mac"
assert_contains "$page" "Speech model$"

cue_control download speakers
wait_log "👥 Downloading speaker models…" 10
wait_log "👥 Speaker models downloaded: [0-9.]+ MB \([0-9.]+ s\)" 300
for file in "${SPEAKER_FILES[@]}"; do
    assert_file "$models/speaker-diarization/$file" "the download should have $file"
done
echo "Speaker models: $(du -sh "$models/speaker-diarization" | cut -f 1) on disk; $(grep -o 'Speaker models downloaded: .*' "$(session_log)")"

# The row is done: no download left to offer (the card goes once everything is set up).
_downloaded() { _dashboard_shows "Tell the people on a call apart|Recent Notes|Create Your First Project" && ! grep -q "MB download, stays on this Mac" "$page"; }
wait_for "the speaker models' row to be done" 20 _downloaded
