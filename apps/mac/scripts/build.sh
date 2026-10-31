#!/bin/bash
# Builds build/Cue.app.
set -euo pipefail
cd "$(dirname "$0")/.."

swift build -c release
APP=build/Cue.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/Cue "$APP/Contents/MacOS/"
cp Resources/Info.plist "$APP/Contents/"
# Release builds stamp their version and build number (the release workflow sets these).
if [[ -n ${CUE_VERSION:-} ]]; then /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $CUE_VERSION" "$APP/Contents/Info.plist"; fi
if [[ -n ${CUE_BUILD:-} ]]; then /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $CUE_BUILD" "$APP/Contents/Info.plist"; fi
cp -R Resources/lexicons Resources/AppIcon.icns "$APP/Contents/Resources/"
# Signing with a real certificate keeps the microphone / screen-audio permissions
# across rebuilds; an ad-hoc signature works too but asks again after every build.
IDENTITY=$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development|Developer ID Application/ {print $2; exit}')
codesign --force --sign "${IDENTITY:--}" --identifier com.andriishafar.cue "$APP"
echo "Built $APP"
