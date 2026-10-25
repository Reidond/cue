#!/bin/bash
# Prints the changes on main since the previous release tag (v*), newest first, one line
# each; a merged pull request is listed by its title. Used for the release notes.
set -euo pipefail
cd "$(dirname "$0")/.."

previous=$(git describe --tags --abbrev=0 --match 'v*' HEAD 2> /dev/null || true)
git log --first-parent --format='%h' "${previous:+$previous..}HEAD" | while read -r hash; do
    subject=$(git log -1 --format=%s "$hash")
    if [[ $subject =~ ^Merge\ pull\ request\ \#([0-9]+) ]]; then
        title=$(git log -1 --format=%b "$hash" | sed -n 1p)
        echo "- ${title:-$subject} (#${BASH_REMATCH[1]})"
    else
        echo "- $subject ($hash)"
    fi
done
