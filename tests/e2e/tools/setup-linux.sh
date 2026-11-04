#!/bin/sh
# Installs what building and checking the backend (`vp check`, `cf build`) needs on Linux (a Boat sandbox, which tests/e2e/remote.ts runs
# this in as root): Node.js 26 and pnpm in /opt/node, beside the Node.js the image has, and rsync. Whatever is there already is kept.
#
#   sudo sh tests/e2e/tools/setup-linux.sh
set -eu
root=$(cd "$(dirname "$0")/../../.." && pwd)
pnpm_version=$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$root/package.json")
[ "$(id -u)" -eq 0 ] || { echo 'Run it as root (sudo)'; exit 1; }
work=$(mktemp -d)
# The cleanup keeps the status it ran with: bash 3.2 (macOS's /bin/sh) would exit with the trap's own.
trap 'status=$?; rm -rf "$work"; exit $status' EXIT
case $(uname -m) in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) echo "No Node.js for $(uname -m)"; exit 1 ;;
esac

# Node.js from nodejs.org, checked against its published SHA-256.
if ! /opt/node/bin/node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 26 ? 0 : 1)' 2>/dev/null; then
    echo 'Installing Node.js 26…'
    base=https://nodejs.org/dist/latest-v26.x
    curl -fsSL "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
    file=$(awk -v name="linux-$arch.tar.xz" '$2 ~ name"$" { print $2 }' "$work/SHASUMS256.txt")
    curl -fsSL "$base/$file" -o "$work/$file"
    (cd "$work" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
    rm -rf /opt/node
    mkdir -p /opt/node
    tar -xJf "$work/$file" -C /opt/node --strip-components=1
fi

if [ "$(/opt/node/bin/pnpm --version 2>/dev/null || true)" != "$pnpm_version" ]; then
    echo "Installing pnpm ${pnpm_version}…"
    PATH=/opt/node/bin:$PATH /opt/node/bin/npm install --global "pnpm@$pnpm_version"
fi

command -v rsync >/dev/null || { apt-get update -qq && apt-get install -y -qq rsync; }

echo
echo "node   $(/opt/node/bin/node --version)"
echo "pnpm   $(/opt/node/bin/pnpm --version)"
