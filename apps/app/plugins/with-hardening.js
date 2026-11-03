'use strict'

const { withAppDelegate, withAppBuildGradle, withProjectBuildGradle, withGradleProperties } = require('expo/config-plugins')
const { patchAppDelegate, patchBuildGradle, patchProjectBuildGradle, patchGradleProperties } = require('./hardening-patches')

// Reapplies the hand edits that `expo prebuild --clean` would drop: the iCloud
// and device backup exclusion of the node's data dir (iOS), release signing
// from outside the repository and the .debug application ID suffix (Android),
// the Kotlin Gradle plugin pinned to android.kotlinVersion, the core library
// desugaring the face liveness SDK needs, and the ABI list
// that matches the linked addons. See docs/development.md.
module.exports = function withHardening (config) {
  config = withAppDelegate(config, config => {
    if (config.modResults.language !== 'swift') throw new Error('native-hardening: AppDelegate is not Swift')
    config.modResults.contents = patchAppDelegate(config.modResults.contents)
    return config
  })
  config = withAppBuildGradle(config, config => {
    config.modResults.contents = patchBuildGradle(config.modResults.contents)
    return config
  })
  config = withProjectBuildGradle(config, config => {
    config.modResults.contents = patchProjectBuildGradle(config.modResults.contents)
    return config
  })
  return withGradleProperties(config, config => {
    config.modResults = patchGradleProperties(config.modResults)
    return config
  })
}
