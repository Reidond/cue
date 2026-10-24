#!/bin/bash
# Runs Cue's end-to-end cases against the built app.
#
#   tests/e2e/run.sh [--no-build] [--real-claude] [--keep] [PREFIX…]
#
#   --no-build     use the existing build/Cue.app
#   --real-claude  use the real `claude` CLI instead of tools/fake-claude.swift
#   --keep         keep every case's sandbox (failed cases are always kept)
#   PREFIX…        run only cases whose file name starts with one of these
#
# Exit status: 0 when nothing failed (skips are fine), 1 otherwise.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
E2E=$ROOT/tests/e2e

build=1
export E2E_CLAUDE=fake E2E_KEEP=0
prefixes=()
for arg in "$@"; do
    case $arg in
        --no-build) build=0 ;;
        --real-claude) E2E_CLAUDE=real ;;
        --keep) E2E_KEEP=1 ;;
        -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) prefixes+=("$arg") ;;
    esac
done

if [[ $build == 1 ]]; then
    echo "Building Cue…"
    "$ROOT/scripts/build.sh" > /dev/null || { echo "Build failed"; exit 1; }
fi
export CUE_APP=$ROOT/build/Cue.app
[[ -x $CUE_APP/Contents/MacOS/Cue ]] || { echo "No $CUE_APP — run without --no-build"; exit 1; }

export E2E_ROOT=$E2E
# One work folder per checkout, so worktrees running cases at once keep their own tools.
export E2E_WORK=${E2E_WORK:-${TMPDIR:-/tmp}/cue-e2e-$(echo "$ROOT" | shasum | cut -c 1-8)}
export E2E_BIN=$E2E_WORK/bin
mkdir -p "$E2E_BIN" "$E2E_WORK/cache"

# Helper tools, rebuilt when their source changes.
for source in "$E2E"/tools/*.swift; do
    tool=$E2E_BIN/$(basename "$source" .swift)
    if [[ ! -x $tool || $source -nt $tool ]]; then
        swiftc -O -o "$tool" "$source" 2> "$tool.log" || { echo "Couldn't build $(basename "$source"):"; cat "$tool.log"; exit 1; }
    fi
done

cases=()
for file in "$E2E"/cases/*.sh; do
    name=$(basename "$file")
    if [[ ${#prefixes[@]} == 0 ]]; then cases+=("$file"); continue; fi
    for prefix in "${prefixes[@]}"; do
        [[ $name == "$prefix"* ]] && { cases+=("$file"); break; }
    done
done
[[ ${#cases[@]} == 0 ]] && { echo "No cases match: ${prefixes[*]}"; exit 1; }

passed=0 failed=0 skipped=0 failures=()
echo "Running ${#cases[@]} case(s), Claude: $E2E_CLAUDE"
for file in "${cases[@]}"; do
    name=$(basename "$file" .sh)
    export E2E_CASE=$name
    output=$E2E_WORK/$name.log
    started=$(date +%s)
    bash "$file" > "$output" 2>&1
    status=$?
    took=$(( $(date +%s) - started ))
    case $status in
        0) passed=$((passed + 1)); printf '  PASS  %-32s %4ss\n' "$name" "$took" ;;
        77) skipped=$((skipped + 1)); printf '  SKIP  %-32s %s\n' "$name" "$(grep -m1 '^SKIP:' "$output" | cut -c7-)" ;;
        *) failed=$((failed + 1)); failures+=("$name")
           printf '  FAIL  %-32s %4ss\n' "$name" "$took"
           tail -n 25 "$output" | sed 's/^/        /' ;;
    esac
done

echo
echo "$passed passed, $failed failed, $skipped skipped  (logs in $E2E_WORK)"
[[ $failed == 0 ]] || { echo "Failed: ${failures[*]}"; exit 1; }
