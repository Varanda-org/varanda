#!/usr/bin/env bash
# EAS Build hook (npm script eas-build-post-install): the build machine starts
# from a clean npm install, so the bare-link addons and the packed worklet do
# not exist yet. prepare-native.sh is idempotent, so this is correct whether
# the service ran pod install before or after this hook.
set -euo pipefail

cd "$(dirname "$0")/.."

case "${EAS_BUILD_PLATFORM:-}" in
  android | ios) platform="$EAS_BUILD_PLATFORM" ;;
  *)
    echo "eas-post-install: EAS_BUILD_PLATFORM must be android or ios (got '${EAS_BUILD_PLATFORM:-}')" >&2
    exit 2
    ;;
esac

bash scripts/prepare-native.sh "$platform"

# The AWS Face Liveness Swift package pulls in smithy-swift's code generator
# plugin and Swift macros, which xcodebuild refuses to run until someone trusts
# them in the Xcode UI. EAS takes no extra xcodebuild flags from this repo, so
# these defaults are the build machine's equivalent of the
# -skipPackagePluginValidation -skipMacroValidation flags native.yml passes;
# the owner approved both on 2026-11-03. The packages are pinned by commit in
# ios/Varanda.xcworkspace/xcshareddata/swiftpm/Package.resolved. The first key
# is misspelled on Apple's side and must stay so.
if [ "$platform" = ios ]; then
  defaults write com.apple.dt.Xcode IDESkipPackagePluginFingerprintValidatation -bool YES
  defaults write com.apple.dt.Xcode IDESkipMacroFingerprintValidation -bool YES
fi

if [ ! -f assets/worklet/main.bundle.js ]; then
  echo "eas-post-install: assets/worklet/main.bundle.js is missing after prepare-native.sh" >&2
  exit 1
fi
echo "eas-post-install: ready ($platform)"
