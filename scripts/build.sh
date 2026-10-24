#!/bin/bash
# Builds build/SeminarOverlay.app with the knowledge base baked into its resources.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f knowledge/qa.json ]; then
    echo "knowledge/ is missing — run scripts/prepare_knowledge.py first" >&2
    exit 1
fi

swift build -c release
APP=build/SeminarOverlay.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/SeminarOverlay "$APP/Contents/MacOS/"
cp Resources/Info.plist "$APP/Contents/"
cp Resources/prompt.md Resources/whisper_prompt.txt Resources/lexicon.json "$APP/Contents/Resources/"
cp -R knowledge "$APP/Contents/Resources/knowledge"
# Signing with a real certificate keeps the microphone / screen-audio permissions
# across rebuilds; an ad-hoc signature works too but asks again after every build.
IDENTITY=$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development|Developer ID Application/ {print $2; exit}')
codesign --force --sign "${IDENTITY:--}" --identifier com.andriishafar.seminar-overlay "$APP"
echo "Built $APP"
