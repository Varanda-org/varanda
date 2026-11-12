'use strict'

// plugins/with-hardening.js: the hand edits of ios/ and android/ that a
// prebuild --clean drops (backup exclusion, release signing, .debug suffix,
// ABI list). The last test runs a real `expo prebuild --clean --no-install`
// in a temp copy of the app (never in apps/app: prebuild would overwrite
// ios/ and android/) and compares the three patched files with the committed
// ones, and the generated privacy manifest with the committed one ignoring
// the whitespace between tags.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('brittle')
const { patchAppDelegate, patchBuildGradle, patchGradleProperties } = require('../plugins/hardening-patches')
const { patchInfoPlist, patchAndroidManifest, MICROPHONE_USAGE } = require('../plugins/with-hardening')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const compact = (xml) => xml.replace(/>\s+</g, '><').trim()

const APP_DELEGATE = 'ios/Varanda/AppDelegate.swift'
const BUILD_GRADLE = 'android/app/build.gradle'
const GRADLE_PROPERTIES = 'android/gradle.properties'
const PRIVACY_MANIFEST = 'ios/Varanda/PrivacyInfo.xcprivacy'
const INFO_PLIST = 'ios/Varanda/Info.plist'
const ENTITLEMENTS = 'ios/Varanda/Varanda.entitlements'
const PBXPROJ = 'ios/Varanda.xcodeproj/project.pbxproj'
const PODFILE_PROPERTIES = 'ios/Podfile.properties.json'
const IOS_MINIMUM = '18.0'
const DEPLOYMENT_TARGET_LINE = 'IPHONEOS_DEPLOYMENT_TARGET = ' + IOS_MINIMUM + ';'
const ANDROID_MANIFEST = 'android/app/src/main/AndroidManifest.xml'
const WELL_KNOWN = '../../deploy/seeder/well-known.sh'
const MIC_PLIST = '<key>NSMicrophoneUsageDescription</key><string>' + MICROPHONE_USAGE + '</string>'
const WEB_CREDENTIALS_PLIST = '<key>VarandaWebCredentials</key><true/>'
// The export compliance answer given in App Store Connect on 2026-11-06
// (standard algorithms, not distributed in France): without it every build
// waits on "Missing Compliance". docs/development.md has the conditions.
const EXPORT_COMPLIANCE_PLIST = '<key>ITSAppUsesNonExemptEncryption</key><false/>'
// The App Privacy answers for App Store Connect, confirmed on 2026-11-08
// (NSPrivacyCollectedDataTypePhoneNumber added with the mobile check; the
// store forms are updated by hand). The form, app.json and the manifest
// change together. docs/development.md.
const collected = (name, linked = true, purposes = ['AppFunctionality']) => ({
  NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataType' + name,
  NSPrivacyCollectedDataTypeLinked: linked,
  NSPrivacyCollectedDataTypeTracking: false,
  NSPrivacyCollectedDataTypePurposes: purposes.map((purpose) => 'NSPrivacyCollectedDataTypePurpose' + purpose)
})
const COLLECTED_DATA_TYPES = [
  ...['EmailAddress', 'PhoneNumber', 'UserID', 'Name', 'PhotosorVideos', 'AudioData', 'OtherUserContent', 'EmailsOrTextMessages', 'OtherDataTypes', 'SensitiveInfo', 'Contacts', 'CoarseLocation'].map((name) => collected(name)),
  collected('SearchHistory', false),
  collected('ProductInteraction', true, ['AppFunctionality', 'Analytics'])
]
const RECORD_AUDIO_LINE = '<uses-permission android:name="android.permission.RECORD_AUDIO"/>'
const CAMERA_REMOVED = '<uses-permission android:name="android.permission.CAMERA" tools:node="remove"/>'

// The keys and the associated domains of an entitlements plist, comments dropped.
function entitlements (xml) {
  const body = compact(xml.replace(/<!--[\s\S]*?-->/g, ''))
  const list = body.match(/<key>com\.apple\.developer\.associated-domains<\/key><array>([\s\S]*?)<\/array>/)
  return {
    keys: [...body.matchAll(/<key>([^<]*)<\/key>/g)].map((m) => m[1]),
    domains: list ? [...list[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]) : []
  }
}

test('the patches change nothing in the committed files', (t) => {
  t.is(patchAppDelegate(read(APP_DELEGATE)), read(APP_DELEGATE))
  t.is(patchBuildGradle(read(BUILD_GRADLE)), read(BUILD_GRADLE))
  const items = [
    { type: 'comment', value: 'Keep in sync with apps/app/scripts/link-addons.sh: bare-link only produces' },
    { type: 'comment', value: '.so addons for arm64-v8a and x86_64; adding other ABIs here breaks the node.' },
    { type: 'property', key: 'reactNativeArchitectures', value: 'arm64-v8a,x86_64' }
  ]
  t.alike(patchGradleProperties(items.map(item => ({ ...item }))), items)
})

test('the patches restore the edits on a generated file', (t) => {
  const delegate = read(APP_DELEGATE)
    .replace('    excludeNodeDataFromBackup()\n', '')
    .replace(/ {2}\/\/ The node's data dir[\s\S]*?\n {2}}\n\n/, '')
  t.absent(delegate.includes('excludeNodeDataFromBackup'))
  t.is(patchAppDelegate(delegate), read(APP_DELEGATE))

  const gradle = read(BUILD_GRADLE)
    .replace(/ {8}\/\/ Release signing comes[\s\S]*?\n {8}}\n(?= {4}}\n {4}buildTypes)/, '')
    .replace(/\n {12}\/\/ A debug build \(public key\)[^\n]*\n {12}applicationIdSuffix '\.debug'/, '')
    .replace('            signingConfig signingConfigs.release\n', '            // Caution! In production, you need to generate your own keystore file.\n' +
      '            // see https://reactnative.dev/docs/signed-apk-android.\n' +
      '            signingConfig signingConfigs.debug\n')
  t.absent(gradle.includes('VARANDA_RELEASE_STORE_FILE'))
  t.absent(gradle.includes('applicationIdSuffix'))
  t.is(patchBuildGradle(gradle), read(BUILD_GRADLE))

  const items = patchGradleProperties([{ type: 'property', key: 'reactNativeArchitectures', value: 'armeabi-v7a,arm64-v8a,x86,x86_64' }])
  t.is(items.length, 3)
  t.is(items[2].value, 'arm64-v8a,x86_64')
})

test('a changed template fails instead of dropping an edit', (t) => {
  t.exception(() => patchAppDelegate('class AppDelegate {}'), /AppDelegate|iCloud/)
  t.exception(() => patchBuildGradle('android {}'), /release signing config/)
  t.exception(() => patchGradleProperties([]), /ABI list/)
})

test('the microphone is declared the same way everywhere, the camera stays removed', (t) => {
  const app = JSON.parse(read('app.json')).expo
  t.is(app.ios.infoPlist.NSMicrophoneUsageDescription, MICROPHONE_USAGE)
  t.ok(app.android.permissions.includes('android.permission.RECORD_AUDIO'))
  t.absent(app.android.permissions.includes('android.permission.CAMERA'))
  t.ok(compact(read(INFO_PLIST)).includes(MIC_PLIST), INFO_PLIST)
  t.ok(read(ANDROID_MANIFEST).includes(RECORD_AUDIO_LINE), ANDROID_MANIFEST)
  t.ok(read(ANDROID_MANIFEST).includes(CAMERA_REMOVED), ANDROID_MANIFEST)
})

test('the export compliance answer is declared the same way in app.json and Info.plist', (t) => {
  const app = JSON.parse(read('app.json')).expo
  t.is(app.ios.config.usesNonExemptEncryption, false, 'app.json')
  t.ok(compact(read(INFO_PLIST)).includes(EXPORT_COMPLIANCE_PLIST), INFO_PLIST)
})

test('the App Privacy answers are declared the same way in app.json and the privacy manifest', (t) => {
  const manifests = JSON.parse(read('app.json')).expo.ios.privacyManifests
  t.is(manifests.NSPrivacyTracking, false, 'no tracking')
  t.alike(manifests.NSPrivacyCollectedDataTypes, COLLECTED_DATA_TYPES, 'app.json')
  const manifest = compact(read(PRIVACY_MANIFEST))
  for (const item of COLLECTED_DATA_TYPES) {
    t.ok(manifest.includes('<key>NSPrivacyCollectedDataType</key><string>' + item.NSPrivacyCollectedDataType + '</string>' +
      '<key>NSPrivacyCollectedDataTypeLinked</key><' + item.NSPrivacyCollectedDataTypeLinked + '/>' +
      '<key>NSPrivacyCollectedDataTypeTracking</key><false/>' +
      '<key>NSPrivacyCollectedDataTypePurposes</key><array>' +
      item.NSPrivacyCollectedDataTypePurposes.map((purpose) => '<string>' + purpose + '</string>').join('') +
      '</array>'), PRIVACY_MANIFEST + ': ' + item.NSPrivacyCollectedDataType)
  }
})

test('the plugin restores the microphone and the camera removal', (t) => {
  t.alike(patchInfoPlist({ CFBundleName: 'Varanda' }), { CFBundleName: 'Varanda', NSMicrophoneUsageDescription: MICROPHONE_USAGE, VarandaWebCredentials: false })
  t.is(patchInfoPlist({}, ['webcredentials:bora.varanda.app']).VarandaWebCredentials, true, 'webcredentials turns the passkey modules on')
  t.is(patchInfoPlist({ VarandaWebCredentials: true }, ['applinks:bora.varanda.app']).VarandaWebCredentials, false, 'applinks alone does not')
  const once = patchAndroidManifest({
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      'uses-permission': [
        { $: { 'android:name': 'android.permission.INTERNET' } },
        { $: { 'android:name': 'android.permission.CAMERA' } },
        { $: { 'android:name': 'android.permission.RECORD_AUDIO', 'tools:node': 'remove' } }
      ]
    }
  })
  const perms = once.manifest['uses-permission'].map((item) => item.$)
  t.is(once.manifest.$['xmlns:tools'], 'http://schemas.android.com/tools')
  t.alike(perms, [
    { 'android:name': 'android.permission.INTERNET' },
    { 'android:name': 'android.permission.CAMERA', 'tools:node': 'remove' },
    { 'android:name': 'android.permission.RECORD_AUDIO' }
  ])
  const twice = patchAndroidManifest(JSON.parse(JSON.stringify(once)))
  t.alike(twice, once, 'idempotent')
  const empty = patchAndroidManifest({ manifest: {} })
  t.is(empty.manifest['uses-permission'].length, 2)
})

// iOS offers the installation's passkeys, and hands the https return of the
// Google step, only to the app named by the apple-app-site-association that
// deploy/seeder/well-known.sh writes from VARANDA_IOS_APP_ID (TEAMID.app.varanda).
// applinks lists only /anuncio/ there, so the public /f/ page stays in the browser.
test('the iOS entitlement, the passkey flag and the deploy name the same app and host', (t) => {
  const app = JSON.parse(read('app.json')).expo
  const committed = entitlements(read(ENTITLEMENTS))
  t.alike(committed.keys, ['com.apple.developer.associated-domains'], 'only Associated Domains for EAS to sync')
  t.alike(committed.domains, ['webcredentials:bora.varanda.app', 'applinks:bora.varanda.app'], ENTITLEMENTS)
  t.alike(app.ios.associatedDomains, committed.domains, 'app.json repeats the entitlement for prebuild')
  t.ok(compact(read(INFO_PLIST)).includes(WEB_CREDENTIALS_PLIST), INFO_PLIST + ' turns the passkey modules on')

  const hosts = [...new Set((read(ANDROID_MANIFEST).match(/android:host="[^"]*"/g) || []).map((h) => h.slice(14, -1)))]
  t.alike(committed.domains, hosts.flatMap((h) => ['webcredentials:' + h, 'applinks:' + h]), 'the host of the Android App Links')

  const pbxproj = read(PBXPROJ)
  t.alike(pbxproj.match(/CODE_SIGN_ENTITLEMENTS = [^;]*;/g), Array(2).fill('CODE_SIGN_ENTITLEMENTS = Varanda/Varanda.entitlements;'), 'Debug and Release sign with it')
  t.alike([...new Set(pbxproj.match(/PRODUCT_BUNDLE_IDENTIFIER = [^;]*;/g))], ['PRODUCT_BUNDLE_IDENTIFIER = ' + app.ios.bundleIdentifier + ';'])

  const wellKnown = read(WELL_KNOWN)
  const appId = app.ios.bundleIdentifier.replace(/\./g, '\\.')
  t.ok(wellKnown.includes('[[ $ios_app_id =~ ^[A-Z0-9]{10}\\.' + appId + '$ ]]'), 'the deploy accepts only TEAMID.' + app.ios.bundleIdentifier)
  t.ok(wellKnown.includes('printf \'{"webcredentials":{"apps":["%s"]},"applinks":{"apps":[],"details":[{"appIDs":["%s"],"components":[{"/":"/anuncio/*"}]}]}}\\n\' "$ios_app_id" "$ios_app_id"'), 'and lists it under webcredentials and applinks (/anuncio/ only)')
})

// Sign-in needs the passkey PRF, which iOS offers from 18.0, so an older iPhone
// must not be able to install the app and dead-end at Entrar. Nothing fails
// when these drift apart: the build just takes whichever value it reads.
test('the iOS minimum is 18.0 everywhere it is set', (t) => {
  const plugins = JSON.parse(read('app.json')).expo.plugins
  const buildProperties = plugins.find((plugin) => plugin[0] === 'expo-build-properties')[1]
  t.is(buildProperties.ios.deploymentTarget, IOS_MINIMUM, 'app.json repeats it for prebuild')
  t.is(JSON.parse(read(PODFILE_PROPERTIES))['ios.deploymentTarget'], IOS_MINIMUM, PODFILE_PROPERTIES)
  t.ok(read('ios/Podfile').includes("podfile_properties['ios.deploymentTarget'] || '" + IOS_MINIMUM + "'"), 'the Podfile fallback')
  t.alike(read(PBXPROJ).match(/IPHONEOS_DEPLOYMENT_TARGET = [^;]*;/g), Array(4).fill(DEPLOYMENT_TARGET_LINE), 'project and app, Debug and Release')
  for (const file of ['modules/passkey-prf/ios/PasskeyPrf.podspec', 'modules/auth-session/ios/AuthSession.podspec']) {
    t.ok(read(file).includes(":ios => '" + IOS_MINIMUM + "'"), file + ' can drop its availability checks')
  }
})

// expo-video's config plugin turns on picture-in-picture and background
// playback, which add an iOS background mode and Android permissions. Short
// videos in posts and momentos need none of them, so the plugin stays out.
test('app.json does not list the expo-video config plugin', (t) => {
  const plugins = JSON.parse(read('app.json')).expo.plugins
  const names = plugins.map((plugin) => Array.isArray(plugin) ? plugin[0] : plugin)
  t.ok(names.length > 0, 'the plugin list is read')
  t.absent(names.some((name) => typeof name === 'string' && name.startsWith('expo-video')), 'no expo-video plugin')
  t.absent(read('app.json').includes('expo-video'), 'expo-video is not configured anywhere in app.json')
})

// The Vitrine (src/vitrine/enabled.js) swaps the node for fixtures. A release
// bundle has __DEV__ false, and no build config may set the opt-in either.
test('a release build cannot turn on the Vitrine', async (t) => {
  const { vitrineEnabled } = await import('../src/vitrine/enabled.js')
  t.is(vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: '1' }, false), false)
  for (const file of ['app.json', 'eas.json', 'metro.config.js', 'index.js', 'App.js']) {
    t.absent(read(file).includes('EXPO_PUBLIC_VARANDA_VITRINE'), file)
  }
  for (const file of ['src/node.js', 'src/account.js']) {
    t.ok(read(file).includes("typeof __DEV__ !== 'undefined' && __DEV__)"), file + ' passes __DEV__')
  }
})

// The perf marks (src/perfMarks.js) also expose a dev-only request hook, so
// they follow the Vitrine's rule: __DEV__ false wins, and no build config
// sets the opt-in.
test('a release build cannot turn on the perf marks or their request hook', async (t) => {
  const { perfEnabled } = await import('../src/perfMarks.js')
  t.is(perfEnabled({ EXPO_PUBLIC_VARANDA_PERF: '1' }, false), false)
  for (const file of ['app.json', 'eas.json', 'metro.config.js', 'index.js', 'App.js']) {
    t.absent(read(file).includes('EXPO_PUBLIC_VARANDA_PERF'), file)
  }
  t.ok(read('src/node.js').includes("perfEnabled({ EXPO_PUBLIC_VARANDA_PERF: process.env.EXPO_PUBLIC_VARANDA_PERF }, typeof __DEV__ !== 'undefined' && __DEV__)"), 'node.js passes __DEV__')
})

test('prebuild --clean plus the plugin reproduces the committed files', (t) => {
  t.timeout(120000)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-prebuild-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }), { force: true })
  for (const name of ['app.json', 'package.json', 'index.js', 'App.js', 'assets', 'plugins']) {
    fs.cpSync(path.join(root, name), path.join(dir, name), { recursive: true })
  }
  fs.symlinkSync(path.join(root, '../../node_modules'), path.join(dir, 'node_modules'))
  const result = spawnSync(process.execPath, [require.resolve('expo/bin/cli'), 'prebuild', '--clean', '--no-install'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1' }
  })
  t.is(result.status, 0, result.stderr)
  for (const file of [APP_DELEGATE, BUILD_GRADLE, GRADLE_PROPERTIES]) {
    t.is(fs.readFileSync(path.join(dir, file), 'utf8'), read(file), file)
  }
  t.is(compact(fs.readFileSync(path.join(dir, PRIVACY_MANIFEST), 'utf8')), compact(read(PRIVACY_MANIFEST)), PRIVACY_MANIFEST)
  const plist = compact(fs.readFileSync(path.join(dir, INFO_PLIST), 'utf8'))
  t.ok(plist.includes(MIC_PLIST), INFO_PLIST + ' declares the microphone')
  t.ok(plist.includes(WEB_CREDENTIALS_PLIST), INFO_PLIST + ' turns the passkey modules on')
  t.ok(plist.includes(EXPORT_COMPLIANCE_PLIST), INFO_PLIST + ' declares the export compliance answer')
  t.alike(entitlements(fs.readFileSync(path.join(dir, ENTITLEMENTS), 'utf8')), entitlements(read(ENTITLEMENTS)), ENTITLEMENTS)
  t.is(JSON.parse(fs.readFileSync(path.join(dir, PODFILE_PROPERTIES), 'utf8'))['ios.deploymentTarget'], IOS_MINIMUM, PODFILE_PROPERTIES)
  // The plugin sets the app target only, which overrides the project's value.
  const generatedTargets = fs.readFileSync(path.join(dir, PBXPROJ), 'utf8').match(/IPHONEOS_DEPLOYMENT_TARGET = [^;]*;/g)
  t.is(generatedTargets.filter((line) => line === DEPLOYMENT_TARGET_LINE).length, 2, PBXPROJ + ' app target, Debug and Release')
  const manifest = fs.readFileSync(path.join(dir, ANDROID_MANIFEST), 'utf8')
  t.ok(manifest.includes(RECORD_AUDIO_LINE), ANDROID_MANIFEST + ' asks for RECORD_AUDIO')
  t.ok(manifest.includes(CAMERA_REMOVED), ANDROID_MANIFEST + ' removes CAMERA')
})
