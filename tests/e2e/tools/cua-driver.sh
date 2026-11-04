#!/bin/bash
# Installs Cua Driver (github.com/trycua/cua) in the Cue macOS VM, for `node tests/e2e/remote.ts mac cua …`: it reads the windows and
# accessibility trees of the apps there and clicks and types into them without taking the VM's pointer or focus. tests/e2e/remote.ts runs
# this as the VM's own user after apps/mac/scripts/setup.sh: Cua Driver is /Applications/CuaDriver.app, ~/.local/bin/cua-driver and a
# LaunchAgent that keeps its daemon running in that user's session.
#
# The installer is the release's, checked here by its SHA-256 (it checks the release's archive against the release's SHA256SUMS and its
# signature itself); telemetry and update checks are off. macOS asks someone at the VM to allow Accessibility and Screen Recording once:
# remote.ts says so when they aren't.
set -euo pipefail
version=0.38.0
tag=cua-driver-rs-v$version
driver=$HOME/.local/bin/cua-driver
work=$(mktemp -d)
trap 'status=$?; rm -rf "$work"; exit $status' EXIT

# URL, SHA-256, name in $work.
fetch() {
    curl -fsSL "$1" -o "$work/$3"
    echo "$2  $work/$3" | shasum -a 256 -c - >/dev/null
}

if ! "$driver" --version 2>/dev/null | grep -q "$version"; then
    echo "Installing Cua Driver ${version}…"
    fetch "https://github.com/trycua/cua/releases/download/$tag/_install-rust.sh" \
        0be0bd269056a7c0c5b15e77ff6c64c880267d091957c97efc19103380e4aeb7 _install-rust.sh
    # Its helpers beside it, where it looks first (else it fetches the newest from cua.ai).
    fetch "https://raw.githubusercontent.com/trycua/cua/$tag/libs/cua-driver/scripts/_install-common.sh" \
        0d5d4b023bfe9111db810b0fde2be23188b703a94093b438edc79b0af8f4b987 _install-common.sh
    CUA_DRIVER_RS_VERSION=$version CUA_DRIVER_RS_NO_MODIFY_PATH=1 CUA_DRIVER_RS_TELEMETRY_ENABLED=false \
        /bin/bash "$work/_install-rust.sh"
fi
# Its settings (config set would need the daemon, and the daemon the permissions).
/usr/local/bin/node -e '
    const fs = require("node:fs"), file = process.argv[1];
    const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    fs.writeFileSync(file, JSON.stringify({ ...config, telemetry_enabled: false, update_check_enabled: false }, null, 2));
' "$HOME/.cua-driver/config.json"

agent=$HOME/Library/LaunchAgents/com.trycua.cua-driver.plist
mkdir -p "$(dirname "$agent")"
cat > "$agent" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.trycua.cua-driver</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/CuaDriver.app/Contents/MacOS/cua-driver</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/com.trycua.cua-driver" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$agent"
for _ in 1 2 3 4 5 6 7 8 9 10; do "$driver" status >/dev/null 2>&1 && break; sleep 1; done
"$driver" --version
