// The store version (versionName / CFBundleShortVersionString, from the
// app.json version the binary was built with) and, on Android, the versionCode
// that EAS remote versioning assigns. expo-constants is already linked by
// expo; no native module is added. iOS has no module that exposes
// CFBundleVersion, so its build number stays unknown here.
let version = null
let versionCode = () => null
try {
  // Loading inside the guard also lets Node import this file without React
  // Native.
  version = require('expo-constants').default.expoConfig.version
  const appBuild = require('../modules/app-build').appBuild
  versionCode = () => {
    const b = appBuild()
    return b === null ? null : b.versionCode
  }
} catch {}

export function nativeStoreVersion () {
  try {
    return { name: version, build: versionCode() }
  } catch {
    return {}
  }
}
