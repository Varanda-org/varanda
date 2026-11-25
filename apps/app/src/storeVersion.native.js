// versionName / CFBundleShortVersionString and versionCode / CFBundleVersion,
// which EAS remote versioning assigns at build time.
let read = () => ({})
try {
  // Loading inside the guard also lets Node import this file without React
  // Native.
  const Application = require('expo-application')
  read = () => ({ name: Application.nativeApplicationVersion, build: Application.nativeBuildVersion })
} catch {}

export function nativeStoreVersion () {
  try {
    return read()
  } catch {
    return {}
  }
}
