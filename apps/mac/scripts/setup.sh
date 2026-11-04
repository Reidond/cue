#!/bin/sh
# Installs what building Cue for macOS and running its end-to-end cases needs, on a fresh Mac (the Cue macOS VM, which
# tests/e2e/remote.ts runs this in as root): Xcode, made the developer folder with its license accepted, Node.js 26 and pnpm, and Chrome
# for the cases that drive the admin SPA. Whatever is there already is kept.
#
#   sudo sh apps/mac/scripts/setup.sh
#
# Xcode itself must be in /Applications already (remote.ts copies the one of the Mac that drives the VM): its Command Line Tools are not
# enough, as SwiftUI's macros (`@State`) are plugins only Xcode has, and Apple's downloads of Xcode need someone's Apple Account.
set -eu
root=$(cd "$(dirname "$0")/../../.." && pwd)
pnpm_version=$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$root/package.json")
[ "$(id -u)" -eq 0 ] || { echo 'Run it as root (sudo, or vmpal exec --admin)'; exit 1; }
work=$(mktemp -d)
# The cleanup keeps the status it ran with: bash 3.2 (macOS's /bin/sh) would exit with the trap's own.
trap 'status=$?; rm -rf "$work"; exit $status' EXIT

[ -d /Applications/Xcode.app ] || { echo 'No /Applications/Xcode.app: copy an Xcode there first'; exit 1; }
if [ "$(xcode-select -p 2>/dev/null)" != /Applications/Xcode.app/Contents/Developer ]; then
    xcode-select --switch /Applications/Xcode.app
fi
# As CI's runners have it: swift and xcodebuild refuse to run until it is.
xcodebuild -license accept
xcodebuild -runFirstLaunch

# Node.js from nodejs.org's installer, checked against its published SHA-256 (into /usr/local/bin, which a login shell has).
if ! /usr/local/bin/node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 26 ? 0 : 1)' 2>/dev/null; then
    echo 'Installing Node.js 26…'
    base=https://nodejs.org/dist/latest-v26.x
    curl -fsSL "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
    pkg=$(awk '$2 ~ /\.pkg$/ { print $2 }' "$work/SHASUMS256.txt")
    curl -fsSL "$base/$pkg" -o "$work/$pkg"
    (cd "$work" && grep " $pkg\$" SHASUMS256.txt | shasum -a 256 -c -)
    installer -pkg "$work/$pkg" -target /
fi

if [ "$(/usr/local/bin/pnpm --version 2>/dev/null || true)" != "$pnpm_version" ]; then
    echo "Installing pnpm ${pnpm_version}…"
    /usr/local/bin/npm install --global "pnpm@$pnpm_version"
fi

# Playwright drives the machine's Chrome (tests/e2e/harness/browser.ts); without it those cases skip.
if [ ! -d '/Applications/Google Chrome.app' ]; then
    echo 'Installing Chrome…'
    curl -fsSL https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg -o "$work/chrome.dmg"
    hdiutil attach -nobrowse -readonly -mountpoint "$work/chrome" "$work/chrome.dmg" >/dev/null
    ditto "$work/chrome/Google Chrome.app" '/Applications/Google Chrome.app'
    hdiutil detach "$work/chrome" >/dev/null
fi

echo
echo "swift  $(swift --version 2>/dev/null | head -1)"
echo "node   $(/usr/local/bin/node --version)"
echo "pnpm   $(/usr/local/bin/pnpm --version)"
