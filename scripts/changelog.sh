#!/bin/bash
# Prints the changes on main in REF (default HEAD) since the release before it (a v* tag),
# newest first, one line each; a merged pull request is listed by its title, with the
# commits it brought in under it. Used for the release notes.
#
#   scripts/changelog.sh [REF]
set -euo pipefail
cd "$(dirname "$0")/.."

ref=${1:-HEAD}
# The release before REF: from its parent, so a REF that is itself tagged still gets its changes.
previous=$(git describe --tags --abbrev=0 --match 'v*' "$ref^" 2> /dev/null || true)
git log --first-parent --format='%h' "${previous:+$previous..}$ref" | while read -r hash; do
    title=$(git log -1 --format=%s "$hash")
    if [[ $title =~ ^Merge\ pull\ request\ \#([0-9]+) ]]; then
        number=${BASH_REMATCH[1]}
        title=$(git log -1 --format=%b "$hash" | sed -n 1p)
        echo "- $title (#$number)"
    else
        echo "- $title ($hash)"
    fi
    # A merge: what the merged branch brought in, without its own merges or the commit the line names.
    if git rev-parse -q --verify "$hash^2" > /dev/null; then
        git log --no-merges --format='%s%x09%h' "$hash^1..$hash^2" | while IFS=$'\t' read -r subject short; do
            [[ $subject == "$title" ]] || echo "  - $subject ($short)"
        done
    fi
done
