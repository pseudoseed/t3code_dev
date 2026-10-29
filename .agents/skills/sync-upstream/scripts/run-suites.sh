#!/usr/bin/env bash
# Every workspace test suite, one package at a time, each to its own log.
#
#   run-suites.sh [package-dir ...]     # no arguments: every package with a test script
#
# `vp run -r test` runs 4 suites at once, and on a Mac the web, mobile and relay suites are
# killed for memory (exit 137). One at a time is slower and finishes. Prints one line per
# package and exits non-zero if any failed. Logs: .agent-scratch/sync-tests/<package>.log
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
export PATH="$ROOT/node_modules/.bin:/opt/homebrew/opt/node@26/bin:$PATH"
LOGS="$ROOT/.agent-scratch/sync-tests"
mkdir -p "$LOGS"

if [ "$#" -gt 0 ]; then
  PACKAGES=("$@")
else
  # shellcheck disable=SC2207
  PACKAGES=($(git ls-files '*package.json' | grep -v '^\.repos/' | xargs node -e '
    for (const file of process.argv.slice(1)) {
      if (file === "package.json") continue;
      if (require(`./${file}`).scripts?.test) console.log(file.replace(/\/package\.json$/, ""));
    }'))
fi

# The desktop suite's Linux icon tests write files whose names differ only by case. A Mac's
# default volume is case-insensitive, so that suite gets its temp files on a case-sensitive one.
CS_IMAGE="$ROOT/.agent-scratch/case-sensitive.sparseimage"
CS_MOUNT="$ROOT/.agent-scratch/case-sensitive"
detach_cs() { hdiutil detach "$CS_MOUNT" -quiet 2>/dev/null || true; }
mount_cs() {
  [ -f "$CS_IMAGE" ] || hdiutil create -size 2g -type SPARSE -fs "Case-sensitive APFS" \
    -volname T3CS -quiet "${CS_IMAGE%.sparseimage}" || return 1
  mkdir -p "$CS_MOUNT"
  trap detach_cs EXIT
  hdiutil attach "$CS_IMAGE" -nobrowse -mountpoint "$CS_MOUNT" -quiet || return 1
  mkdir -p "$CS_MOUNT/tmp"
}

failed=0
for dir in "${PACKAGES[@]}"; do
  log="$LOGS/$(echo "$dir" | tr / _).log"
  if [ "$dir" = "apps/desktop" ] && [ "$(uname)" = "Darwin" ]; then
    mount_cs || { echo "Could not mount a case-sensitive volume at $CS_MOUNT." >&2; exit 1; }
    (cd "$dir" && TMPDIR="$CS_MOUNT/tmp" vp run test) > "$log" 2>&1
    status=$?
    detach_cs
  else
    (cd "$dir" && vp run test) > "$log" 2>&1
    status=$?
  fi
  # Vitest prints one "Tests  N passed (N)" line per run; strip colour codes before reading it.
  tests="$(sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -E '^ +Tests +[0-9]' | tail -1 | sed 's/^ *Tests *//')"
  if [ "$status" -eq 0 ]; then
    echo "PASS  $dir  ${tests:-no tests}"
  else
    failed=$((failed + 1))
    echo "FAIL  $dir  ${tests:-exit $status}  $log"
  fi
done

echo
if [ "$failed" -gt 0 ]; then
  echo "$failed of ${#PACKAGES[@]} packages failed."
  exit 1
fi
echo "All ${#PACKAGES[@]} packages passed."
