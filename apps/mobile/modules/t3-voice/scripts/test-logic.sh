#!/usr/bin/env bash
#
# Runs the module's pure-Swift tests.
#
# Separate from the app because `apps/mobile/ios` is generated and cannot hold a
# test target that survives a prebuild.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
swift test
