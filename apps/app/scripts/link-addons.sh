#!/usr/bin/env bash
# Links the native addons of the worklet's module graph (bare-link) into the
# directories react-native-bare-kit already wires into its native projects:
#   <react-native-bare-kit>/ios/addons/*.xcframework            (podspec vendored_frameworks)
#   <react-native-bare-kit>/android/src/main/addons/<abi>/*.so  (jniLibs.srcDirs)
# so neither ios/ nor android/ needs project changes. These directories live
# in node_modules: run this again after every npm install / npm ci (then
# pod install, which picks up the frameworks).
# Fails unless each platform linked rocksdb-native, udx-native, sodium-native
# and bare-fs (bare-link issue #49 links zero addons in some monorepos), and
# the addons the web node kind cannot run without: fs-native-extensions (its
# data-dir lock fails closed without it), bare-crypto and bare-tls (wss).
# Run from anywhere: npm run link:addons -w apps/app [-- ios|android|all]
# With `check` first, only verifies what is already linked (npm run ios and
# npm run android do, so a build never starts without the addons):
#   bash scripts/link-addons.sh check [ios|android|all]
set -euo pipefail

cd "$(dirname "$0")/.."

only_check=0
if [ "${1:-}" = "check" ]; then
  only_check=1
  shift
fi
which="${1:-all}"
entry="worklet/main.js"
bare_link="../../node_modules/.bin/bare-link"
kit="$(node -p "require('path').dirname(require.resolve('react-native-bare-kit/package.json'))")"
required=(rocksdb-native udx-native sodium-native bare-fs fs-native-extensions bare-crypto bare-tls)

check () {
  local platform="$1" dir="$2" pattern="$3"
  local linked
  if [ ! -d "$dir" ]; then
    echo "link-addons: FAIL: $dir does not exist; run npm run prepare:native -w apps/app" >&2
    exit 1
  fi
  linked="$(find "$dir" -maxdepth 1 -name "$pattern" | sed -E 's#.*/##; s#^lib##; s#\.(xcframework|so)$##' | sort -u)"
  echo "linked ($platform):"
  echo "$linked" | sed 's/^/  /'
  for name in "${required[@]}"; do
    if ! echo "$linked" | grep -Eq "^${name}\.[0-9]+\.[0-9]+\.[0-9]+$"; then
      echo "link-addons: FAIL: $name not linked for $platform; run npm run prepare:native -w apps/app" >&2
      exit 1
    fi
  done
}

if [ "$which" = "all" ] || [ "$which" = "ios" ]; then
  out="$kit/ios/addons"
  if [ "$only_check" = 0 ]; then
    rm -rf "$out"
    "$bare_link" --preset ios --out "$out" "$entry"
  fi
  check ios "$out" '*.xcframework'
fi

if [ "$which" = "all" ] || [ "$which" = "android" ]; then
  out="$kit/android/src/main/addons"
  if [ "$only_check" = 0 ]; then
    rm -rf "$out"
    "$bare_link" --preset android --out "$out" "$entry"
  fi
  for abi in arm64-v8a x86_64; do
    check "android $abi" "$out/$abi" '*.so'
  done
fi
