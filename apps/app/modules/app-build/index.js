// The installed Android build (versionCode) and whether Google Play installed
// it. Web, iOS and Node have no such module, so there appBuild() returns null.
// Both values are checked here, since the native side is outside this code.
//
// Autolinked from apps/app/modules (expo-modules-autolinking's default
// nativeModulesDir), on Android only.

let native = null
try {
  // Loading inside the guard also lets Node import without React Native.
  const { requireNativeModule } = require('expo-modules-core')
  native = requireNativeModule('AppBuild') ?? null
} catch {}

// Google Play refuses a versionCode above this.
export const MAX_VERSION_CODE = 2100000000

export function isAvailable () {
  return native !== null
}

// -> { versionCode, fromPlay } or null when a value is missing or malformed.
export function buildOf (source) {
  try {
    if (source === null || typeof source !== 'object') return null
    const versionCode = source.versionCode
    const fromPlay = source.fromPlay
    if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > MAX_VERSION_CODE) return null
    if (typeof fromPlay !== 'boolean') return null
    return { versionCode, fromPlay }
  } catch {
    return null
  }
}

export function appBuild () {
  return native === null ? null : buildOf(native)
}
