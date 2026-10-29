#!/usr/bin/env bash
# One command to get ios/ and android/ ready to build after an npm install:
# link the addons (and fail unless they are all linked), pack the worklet
# and, for iOS on macOS, run pod install. It never runs expo prebuild: ios/ and
# android/ are committed, and plugins/with-hardening.js keeps their hand
# edits reproducible (test/hardening.test.js).
# Run from anywhere: npm run prepare:native -w apps/app [-- ios|android|all]
set -euo pipefail

cd "$(dirname "$0")/.."

which="${1:-all}"
case "$which" in
  all | ios | android) ;;
  *) echo "usage: prepare-native.sh [ios|android|all]" >&2; exit 2 ;;
esac

bash scripts/link-addons.sh "$which"
bash scripts/pack-worklet.sh

if [ "$which" != "android" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    (cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install)
  else
    echo "prepare-native: pod install skipped (iOS builds need macOS)"
  fi
fi

bash scripts/link-addons.sh check "$which" > /dev/null
echo "prepare-native: ready ($which)"
