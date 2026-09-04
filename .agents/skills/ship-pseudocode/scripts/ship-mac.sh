#!/usr/bin/env bash
# Signed, notarized, stapled macOS DMG for the PseudoCode fork.
#
#   ship-mac.sh [arm64|x64]
#
# Needs a Developer ID Application identity in the login keychain and a notarytool keychain
# profile. See ../ROTATION.md to set both up. No secret is named on any command line.
set -euo pipefail

ARCH="${1:-arm64}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

ROOT="$(repo_root)"
cd "$ROOT"
setup_path "$ROOT"
load_env_local "$ROOT"
require_vars T3CODE_APP_NAME T3CODE_APP_ICON

PROFILE="${APPLE_KEYCHAIN_PROFILE:-pseudocode}"
export APPLE_KEYCHAIN_PROFILE="$PROFILE"

if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo "No Developer ID Application identity in the keychain. See ROTATION.md." >&2
  exit 1
fi

LOG="$(mktemp -t pseudocode-mac)"
echo "Building $T3CODE_APP_NAME for $ARCH. Log: $LOG"
vp run dist:desktop:artifact --platform mac --target dmg --arch "$ARCH" --signed --verbose \
  2>&1 | tee "$LOG"

if grep -q "skipped macOS notarization" "$LOG"; then
  echo >&2
  echo "Build finished but was NOT notarized: no notarytool profile named '$PROFILE'." >&2
  echo "Create it with the step 6 command in ROTATION.md, then re-run." >&2
  exit 1
fi

DMG="$(ls -t release/*.dmg | head -1)"
MOUNT="$(mktemp -d)"
cleanup() { hdiutil detach "$MOUNT" -quiet 2>/dev/null || true; }
trap cleanup EXIT

hdiutil attach "$DMG" -nobrowse -quiet -mountpoint "$MOUNT"
APP="$(find "$MOUNT" -maxdepth 1 -name '*.app' | head -1)"

echo
echo "Verifying $(basename "$APP")"
codesign --verify --deep --strict "$APP"
xcrun stapler validate "$APP"
spctl --assess --verbose=4 --type exec "$APP"

echo
echo "Shipped: $DMG"
