'use strict'

const { withAppDelegate, withAppBuildGradle, withGradleProperties } = require('expo/config-plugins')
const { patchAppDelegate, patchBuildGradle, patchGradleProperties } = require('./hardening-patches')

// Reapplies the hand edits that `expo prebuild --clean` would drop: the iCloud
// and device backup exclusion of the node's data dir (iOS), release signing
// from outside the repository and the .debug application ID suffix (Android),
// and the ABI list that matches the linked addons. See docs/development.md.
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
  return withGradleProperties(config, config => {
    config.modResults = patchGradleProperties(config.modResults)
    return config
  })
}
