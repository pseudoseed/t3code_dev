#!/usr/bin/env bash
#
# Builds the llama.cpp xcframework the cleanup engine links against.
#
# Built from upstream source at a pinned tag rather than taken from a release
# asset: llama.cpp's published xcframework carries no iOS simulator slice, and
# without one the app cannot be verified anywhere but a physical device.
#
# The output is gitignored. A checkout that has not run this script fails to
# link with a missing-framework error, which is the honest failure.
set -euo pipefail

# Bump deliberately. A moving llama.cpp cannot coexist with a single-shot
# release, and the GGUF format it reads changes between builds.
LLAMA_TAG="b10793"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(dirname "$SCRIPT_DIR")"
VENDOR_DIR="$MODULE_DIR/ios/Vendor"
OUTPUT="$VENDOR_DIR/llama.xcframework"
STAMP="$VENDOR_DIR/.llama-stamp"

if [[ -f "$STAMP" && "$(cat "$STAMP")" == "$LLAMA_TAG" && -d "$OUTPUT" ]]; then
  echo "llama.xcframework is already at $LLAMA_TAG"
  exit 0
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Cloning llama.cpp at $LLAMA_TAG"
git clone --quiet --depth 1 --branch "$LLAMA_TAG" \
  https://github.com/ggml-org/llama.cpp.git "$WORK_DIR/llama.cpp"

cd "$WORK_DIR/llama.cpp"
echo "Building iOS device and simulator slices. This takes several minutes."
# Only the two slices the app ships and is tested on. The upstream default
# builds seven, most of a which are platforms this app does not run on.
./build-xcframework.sh ios-device ios-sim

rm -rf "$OUTPUT"
mkdir -p "$VENDOR_DIR"
cp -R "$WORK_DIR/llama.cpp/build-apple/llama.xcframework" "$OUTPUT"
printf '%s' "$LLAMA_TAG" > "$STAMP"

echo "Wrote $OUTPUT at $LLAMA_TAG"
