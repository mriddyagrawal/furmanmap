#!/usr/bin/env bash
# Which commits have not been reviewed yet?
#
# The answer is derived, not stored: comments.md records the short SHA of every
# commit it reviews, so "unreviewed" is simply "reachable from HEAD, newer than
# the oldest thing in comments.md, and not mentioned there". No queue file,
# nothing to drift out of sync, and an amend or a rebase fixes itself on the
# next run.
#
# The oldest reviewed commit is the boundary on purpose. Everything before it
# predates the review process, and a tool that reports a 34-commit backlog
# every time you commit is a tool people turn off. Pass DEPTH= to look further.
#
# Merges are skipped — they carry no changes of their own, and reviewing the
# same diff twice under two SHAs is noise.
#
# bash 3.2 compatible: macOS still ships it, and `mapfile` does not exist there.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/comments.md"
DEPTH="${DEPTH:-60}"

[ -f "$LOG" ] || { echo "no comments.md — nothing has been reviewed yet" >&2; exit 1; }

pending=""
count=0
seen_reviewed=0

# Process substitution, not a pipe: the loop must run in this shell so `break`
# and the accumulated list survive it.
while IFS= read -r entry; do
  sha="${entry%% *}"
  if grep -qi "$(printf %.7s "$sha")" "$LOG"; then
    seen_reviewed=1
    continue
  fi
  # Unreviewed but older than everything reviewed: predates the process.
  if [ "$seen_reviewed" -eq 1 ]; then
    break
  fi
  pending="${pending}  ${entry}"$'\n'
  count=$(( count + 1 ))
done < <(git -C "$ROOT" log --no-merges --format='%h %s' -n "$DEPTH")

if [ "$count" -eq 0 ]; then
  echo "✓ nothing to review — comments.md is current with HEAD"
  exit 0
fi

echo "$count commit(s) awaiting review:"
printf '%s' "$pending"
echo
echo 'Review them with:  claude "/review-commits"'
exit 1
