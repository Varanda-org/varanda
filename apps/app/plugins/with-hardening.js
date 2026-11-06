'use strict'

const { withAppDelegate, withAppBuildGradle, withGradleProperties, withInfoPlist, withAndroidManifest } = require('expo/config-plugins')
const { patchAppDelegate, patchBuildGradle, patchGradleProperties } = require('./hardening-patches')

const MICROPHONE_USAGE = 'Para gravar mensagens de voz nas Conversas.'
const RECORD_AUDIO = 'android.permission.RECORD_AUDIO'
// expo-image-picker merges CAMERA into the manifest; photos only come from
// the library, so the permission stays out of the build.
const CAMERA = 'android.permission.CAMERA'

// Voice notes in Conversas need the microphone; the text is the one the
// committed ios/Varanda/Info.plist carries.
function patchInfoPlist (plist) {
  plist.NSMicrophoneUsageDescription = MICROPHONE_USAGE
  return plist
}

function patchAndroidManifest (manifest) {
  const root = manifest.manifest
  root.$ = root.$ || {}
  root.$['xmlns:tools'] = root.$['xmlns:tools'] || 'http://schemas.android.com/tools'
  const list = Array.isArray(root['uses-permission']) ? root['uses-permission'] : []
  const find = (name) => list.find((item) => item.$ && item.$['android:name'] === name)
  const record = find(RECORD_AUDIO)
  if (!record) list.push({ $: { 'android:name': RECORD_AUDIO } })
  else delete record.$['tools:node']
  const camera = find(CAMERA)
  if (!camera) list.push({ $: { 'android:name': CAMERA, 'tools:node': 'remove' } })
  else camera.$['tools:node'] = 'remove'
  root['uses-permission'] = list
  return manifest
}

// Reapplies the hand edits that `expo prebuild --clean` would drop: the iCloud
// and device backup exclusion of the node's data dir (iOS), release signing
// from outside the repository and the .debug application ID suffix (Android),
// the ABI list that matches the linked addons, and the microphone declaration
// of voice notes (with the camera kept out). See docs/development.md.
function withHardening (config) {
  config = withAppDelegate(config, config => {
    if (config.modResults.language !== 'swift') throw new Error('native-hardening: AppDelegate is not Swift')
    config.modResults.contents = patchAppDelegate(config.modResults.contents)
    return config
  })
  config = withAppBuildGradle(config, config => {
    config.modResults.contents = patchBuildGradle(config.modResults.contents)
    return config
  })
  config = withInfoPlist(config, config => {
    config.modResults = patchInfoPlist(config.modResults)
    return config
  })
  config = withAndroidManifest(config, config => {
    config.modResults = patchAndroidManifest(config.modResults)
    return config
  })
  return withGradleProperties(config, config => {
    config.modResults = patchGradleProperties(config.modResults)
    return config
  })
}

module.exports = withHardening
module.exports.patchInfoPlist = patchInfoPlist
module.exports.patchAndroidManifest = patchAndroidManifest
module.exports.MICROPHONE_USAGE = MICROPHONE_USAGE
