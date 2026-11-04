#!/bin/bash
# Builds build/Cue.app.
set -euo pipefail
cd "$(dirname "$0")/.."
# Cue is built in the Cue macOS VM (tests/e2e/remote.ts) or on CI, never on a Mac someone works at: macOS says it is a VM's.
if [[ -z ${CI:-} && $(sysctl -n kern.hv_vmm_present 2>/dev/null) != 1 ]]; then
    echo "Cue isn't built on this Mac: node tests/e2e/remote.ts mac apps/mac/scripts/build.sh" >&2
    exit 1
fi

swift build -c release
APP=build/Cue.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/Cue "$APP/Contents/MacOS/"
cp Resources/Info.plist "$APP/Contents/"
# The backend's address is kept in one place, apps/api/production-url.txt (the Worker's issuer reads it too); CUE_API_URL still overrides it at run time.
API_URL=$(tr -d '[:space:]' < ../api/production-url.txt)
/usr/libexec/PlistBuddy -c "Add :CueAPIURL string $API_URL" "$APP/Contents/Info.plist"
# Release builds stamp their version and build number (the release workflow sets these).
if [[ -n ${CUE_VERSION:-} ]]; then /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $CUE_VERSION" "$APP/Contents/Info.plist"; fi
if [[ -n ${CUE_BUILD:-} ]]; then /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $CUE_BUILD" "$APP/Contents/Info.plist"; fi
# A release build also stamps the repository whose GitHub releases it updates itself from (OWNER/NAME): without it Cue doesn't look for updates.
if [[ -n ${CUE_UPDATES:-} ]]; then /usr/libexec/PlistBuddy -c "Add :CueUpdates string $CUE_UPDATES" "$APP/Contents/Info.plist"; fi
cp -R Resources/lexicons Resources/AppIcon.icns "$APP/Contents/Resources/"
# Signing with a real certificate keeps the microphone / screen-audio permissions
# across rebuilds; an ad-hoc signature works too but asks again after every build.
IDENTITY=$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development|Developer ID Application/ {print $2; exit}')
codesign --force --sign "${IDENTITY:--}" --identifier com.andriishafar.cue "$APP"
echo "Built $APP"
