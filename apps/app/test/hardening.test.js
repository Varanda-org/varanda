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
const SHARE_ENTITLEMENTS = 'ios/VarandaShare/VarandaShare.entitlements'
const SHARE_INFO_PLIST = 'ios/VarandaShare/Info.plist'
const SHARE_PRIVACY_MANIFEST = 'ios/VarandaShare/PrivacyInfo.xcprivacy'
const SHARE_CONTROLLER = 'ios/VarandaShare/ShareViewController.swift'
const SHARE_INTAKE_SWIFT = 'modules/share-intake/ios/ShareIntakeModule.swift'
const SHARE_BUNDLE_ID = 'app.varanda.share'
const APP_GROUP = 'group.app.varanda'
const ASSOCIATED_DOMAINS_KEY = 'com.apple.developer.associated-domains'
const APP_GROUPS_KEY = 'com.apple.security.application-groups'
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

// The keys (sorted), the associated domains and the app groups of an
// entitlements plist, comments dropped.
function entitlements (xml) {
  const body = compact(xml.replace(/<!--[\s\S]*?-->/g, ''))
  const strings = (key) => {
    const at = body.indexOf('<key>' + key + '</key><array>')
    if (at === -1) return []
    const list = body.slice(at).match(/<array>([\s\S]*?)<\/array>/)[1]
    return [...list.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
  }
  return {
    keys: [...body.matchAll(/<key>([^<]*)<\/key>/g)].map((m) => m[1]).sort(),
    domains: strings(ASSOCIATED_DOMAINS_KEY),
    groups: strings(APP_GROUPS_KEY)
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
  t.alike(committed.keys, [ASSOCIATED_DOMAINS_KEY, APP_GROUPS_KEY], 'only Associated Domains and App Groups for EAS to sync')
  t.alike(committed.domains, ['webcredentials:bora.varanda.app', 'applinks:bora.varanda.app'], ENTITLEMENTS)
  t.alike(app.ios.associatedDomains, committed.domains, 'app.json repeats the entitlement for prebuild')
  t.ok(compact(read(INFO_PLIST)).includes(WEB_CREDENTIALS_PLIST), INFO_PLIST + ' turns the passkey modules on')

  const hosts = [...new Set((read(ANDROID_MANIFEST).match(/android:host="[^"]*"/g) || []).map((h) => h.slice(14, -1)))]
  t.alike(committed.domains, hosts.flatMap((h) => ['webcredentials:' + h, 'applinks:' + h]), 'the host of the Android App Links')

  const pbxproj = read(PBXPROJ)
  t.alike(pbxproj.match(/CODE_SIGN_ENTITLEMENTS = [^;]*;/g), [
    ...Array(2).fill('CODE_SIGN_ENTITLEMENTS = Varanda/Varanda.entitlements;'),
    ...Array(2).fill('CODE_SIGN_ENTITLEMENTS = VarandaShare/VarandaShare.entitlements;')
  ], 'Debug and Release of the app and of the share extension sign with their own file')
  t.alike([...new Set([...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]*);/g)].map((m) => m[1]))].sort(), [app.ios.bundleIdentifier, SHARE_BUNDLE_ID], 'the app and its share extension')
  t.ok(SHARE_BUNDLE_ID.startsWith(app.ios.bundleIdentifier + '.'), 'the extension id is under the app id')

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
  t.alike(read(PBXPROJ).match(/IPHONEOS_DEPLOYMENT_TARGET = [^;]*;/g), Array(6).fill(DEPLOYMENT_TARGET_LINE), 'project, app and share extension, Debug and Release')
  for (const file of ['modules/passkey-prf/ios/PasskeyPrf.podspec', 'modules/auth-session/ios/AuthSession.podspec', 'modules/share-intake/ios/ShareIntake.podspec']) {
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

// The share extension (ios/VarandaShare) writes into the app group container
// and ShareIntakeModule.swift reads it there: a group missing from either
// entitlements file, or spelled differently, makes every share vanish.
test('the app, the share extension and the share module use one app group', (t) => {
  const app = entitlements(read(ENTITLEMENTS))
  const share = entitlements(read(SHARE_ENTITLEMENTS))
  t.alike(app.groups, [APP_GROUP], ENTITLEMENTS)
  t.alike(share.keys, [APP_GROUPS_KEY], SHARE_ENTITLEMENTS + ' has the app group only')
  t.alike(share.groups, [APP_GROUP], SHARE_ENTITLEMENTS)
  t.alike(JSON.parse(read('app.json')).expo.ios.entitlements, { [APP_GROUPS_KEY]: [APP_GROUP] }, 'app.json repeats it for prebuild')
  t.ok(read(SHARE_INTAKE_SWIFT).includes('static let appGroup = "' + APP_GROUP + '"'), SHARE_INTAKE_SWIFT + ' reads that group')
  t.ok(read(SHARE_CONTROLLER).includes('static let appGroup = "' + APP_GROUP + '"'), SHARE_CONTROLLER + ' writes that group')
  for (const file of [SHARE_INTAKE_SWIFT, SHARE_CONTROLLER]) {
    t.ok(read(file).includes('static let inboxPath = "Library/Caches/share-inbox"'), file + ' uses the one inbox path')
    t.ok(read(file).includes('static let manifestName = "manifest.json"'), file + ' uses the one manifest name')
  }
})

// The extension cannot run the app's cleanup, so its inbox stays out of
// device backups and it drops what is past SHARE_TTL_MS itself.
test('the share extension keeps its inbox out of backups and drops expired shares', (t) => {
  const source = read(SHARE_CONTROLLER)
  const prepare = source.slice(source.indexOf('private func prepareEntry('), source.indexOf('private func complete('))
  t.ok(prepare.includes('values.isExcludedFromBackup = true'), 'excluded from backup')
  t.ok(prepare.includes('try? inbox.setResourceValues(values)'), 'set on the inbox')
  const ttl = /SHARE_TTL_MS = (\d+)/.exec(read('src/sharedIntent.js'))
  t.ok(ttl && Number(ttl[1]) === 60 * 60 * 1000, 'SHARE_TTL_MS is 1 hour')
  t.ok(source.includes('private static let ttlMs: Int64 = 60 * 60 * 1000'), 'the extension uses the same lifetime')
})

// A format the app refuses would reach Publicar as nothing, so the extension
// picks an admitted one first when the source app offers several.
test('the share extension prefers the formats the app imports', (t) => {
  const source = read(SHARE_CONTROLLER)
  const list = /static let allowedTypes: \[UTType\] = ([^\n]+\n[^\n]+)/
  const ext = list.exec(source)
  const mod = list.exec(read(SHARE_INTAKE_SWIFT))
  t.ok(ext && mod && ext[1] === mod[1], 'one format list in the extension and the module')
  const pick = source.slice(source.indexOf('private static func imageType('), source.indexOf('private static func fileExtension('))
  const allowed = pick.indexOf('allowedTypes.contains(where: { type.conforms(to: $0) })')
  t.ok(allowed > 0 && allowed < pick.indexOf('type.conforms(to: .image)'), 'an admitted format comes before any other image type')
})

// The body of the pbxproj object whose header ends with `head`.
function pbxObject (pbxproj, head) {
  const at = pbxproj.indexOf(head)
  if (at === -1) return ''
  const end = pbxproj.indexOf('\n\t\t};\n', at)
  return end === -1 ? '' : pbxproj.slice(at, end)
}

// The quoted or bare entries of a parenthesized pbxproj list.
function pbxList (object, key) {
  const list = object.match(new RegExp('\\b' + key + ' = \\(([\\s\\S]*?)\\);'))
  return list ? list[1].split(',\n').map((item) => item.trim()).filter(Boolean) : []
}

// An Xcode build setting reference as a script phase writes it.
const buildVar = (name) => '$' + '{' + name + '}'
const HOST_PLIST_PATH = buildVar('SRCROOT') + '/Varanda/Info.plist'
const BUILT_PLIST_PATH = buildVar('TARGET_BUILD_DIR') + '/' + buildVar('INFOPLIST_PATH')

const phaseNames = (target) => pbxList(target, 'buildPhases').map((item) => item.replace(/^\w{24} \/\* (.*) \*\/$/, '$1'))

// The extension is built by the Varanda target's dependency and copied into
// Varanda.app/PlugIns before the React Native and Pods script phases (after
// them Xcode can report a build cycle). Apple rejects an extension whose
// versions differ from the app's, and EAS rewrites only the app's Info.plist,
// so the extension's last phase copies the app's versions into its own.
test('the share extension target is built, embedded and versioned like the app', (t) => {
  const pbxproj = read(PBXPROJ)
  const shareHeader = /(\w{24}) \/\* VarandaShare \*\/ = \{\n\t\t\tisa = PBXNativeTarget;/.exec(pbxproj)
  t.ok(shareHeader, 'a VarandaShare native target')
  const share = pbxObject(pbxproj, '/* VarandaShare */ = {\n\t\t\tisa = PBXNativeTarget;')
  t.ok(share.includes('productType = "com.apple.product-type.app-extension";'), 'an app extension')
  t.ok(share.includes('/* VarandaShare.appex */;'), 'that makes VarandaShare.appex')
  t.alike(phaseNames(share), ['Sources', 'Frameworks', 'Resources', 'Sync version with Varanda'], 'its phases, the version sync last')
  t.alike(pbxList(share, 'dependencies'), [], 'no pods and no other target')

  const app = pbxObject(pbxproj, '/* Varanda */ = {\n\t\t\tisa = PBXNativeTarget;')
  const appPhases = phaseNames(app)
  const embedAt = appPhases.indexOf('Embed Foundation Extensions')
  t.ok(embedAt !== -1, 'the app embeds extensions')
  t.ok(embedAt < appPhases.indexOf('Bundle React Native code and images'), 'before the React Native bundle')
  t.ok(embedAt < appPhases.indexOf('[CP] Embed Pods Frameworks'), 'before the Pods frameworks')
  t.is(pbxList(app, 'dependencies').length, 1, 'the app depends on one target')
  t.ok(pbxproj.includes('target = ' + (shareHeader && shareHeader[1]) + ' /* VarandaShare */;'), 'and it is VarandaShare')

  const embed = pbxObject(pbxproj, '/* Embed Foundation Extensions */ = {\n\t\t\tisa = PBXCopyFilesBuildPhase;')
  t.ok(embed.includes('dstSubfolderSpec = 13;'), 'copied into PlugIns')
  t.alike(pbxList(embed, 'files').map((item) => item.replace(/^\w{24} /, '')), ['/* VarandaShare.appex in Embed Foundation Extensions */'], 'the appex only')

  const sync = pbxObject(pbxproj, '/* Sync version with Varanda */ = {\n\t\t\tisa = PBXShellScriptBuildPhase;')
  t.alike(pbxList(sync, 'inputPaths'), ['"' + HOST_PLIST_PATH + '"', '"' + BUILT_PLIST_PATH + '"'], 'reads the app plist after the extension plist is processed')
  // Xcode's own Info.plist task produces the processed plist; a second
  // producer of one file fails the build ("Multiple commands produce").
  t.alike(pbxList(sync, 'outputPaths'), ['"' + buildVar('DERIVED_FILE_DIR') + '/VarandaShare-version-sync.stamp"'], 'declares a stamp, not the plist it edits')
  t.ok(sync.includes('shellPath = /bin/bash;'), 'bash')
  const script = (sync.match(/shellScript = "((?:[^"\\]|\\.)*)";/) || [])[1] || ''
  t.ok(script.startsWith('set -euo pipefail\\n'), 'fails on any error')
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    t.ok(script.includes('/usr/libexec/PlistBuddy -c \\"Print :' + key + '\\" \\"$host\\"'), 'reads ' + key + ' from the app')
    t.ok(script.includes('/usr/libexec/PlistBuddy -c \\"Set :' + key + ' $'), 'sets ' + key + ' in the extension')
  }
  t.ok(script.includes('host=\\"' + HOST_PLIST_PATH + '\\"'), 'the app plist')
  t.ok(script.includes('plist=\\"' + BUILT_PLIST_PATH + '\\"'), 'the built extension plist')

  for (const setting of ['INFOPLIST_FILE = VarandaShare/Info.plist;', 'APPLICATION_EXTENSION_API_ONLY = YES;', 'SKIP_INSTALL = YES;', 'MARKETING_VERSION = 0.1.0;', 'CURRENT_PROJECT_VERSION = 1;']) {
    t.is(pbxproj.split(setting).length - 1, setting.startsWith('MARKETING') || setting.startsWith('CURRENT') ? 4 : 2, setting)
  }
  t.absent(/SWIFT_OBJC_BRIDGING_HEADER = "?VarandaShare/.test(pbxproj), 'no bridging header')

  const privacy = /(\w{24}) \/\* PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference; lastKnownFileType = text\.xml; path = PrivacyInfo\.xcprivacy;/.exec(pbxproj)
  const privacyFile = privacy && new RegExp('(\\w{24}) /\\* PrivacyInfo\\.xcprivacy in Resources \\*/ = \\{isa = PBXBuildFile; fileRef = ' + privacy[1]).exec(pbxproj)
  const resources = pbxList(share, 'buildPhases').find((item) => item.endsWith('/* Resources */')) || ''
  t.ok(privacyFile && pbxObject(pbxproj, resources + ' = {').includes(privacyFile[1]), 'the extension ships its own privacy manifest')
})

const plistValue = (xml, key) => (compact(xml).match(new RegExp('<key>' + key + '</key><string>([^<]*)</string>')) || [])[1]

test('the share extension accepts photos, text and one link, with the app\'s versions', (t) => {
  const xml = read(SHARE_INFO_PLIST)
  const plist = compact(xml)
  const rule = '<key>NSExtensionActivationSupportsImageWithMaxCount</key><integer>100</integer>' +
    '<key>NSExtensionActivationSupportsText</key><true/>' +
    '<key>NSExtensionActivationSupportsWebURLWithMaxCount</key><integer>1</integer>'
  t.ok(plist.includes('<key>NSExtension</key><dict>' +
    '<key>NSExtensionAttributes</key><dict><key>NSExtensionActivationRule</key><dict>' + rule + '</dict></dict>' +
    '<key>NSExtensionPointIdentifier</key><string>com.apple.share-services</string>' +
    '<key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).ShareViewController</string>' +
    '</dict>'), 'NSExtension holds the rule inside NSExtensionAttributes')
  t.absent(/Movie|NSExtensionActivationSupportsFile|Attachment/.test(plist), 'no movie or file activation key')
  t.absent(/SUBQUERY|<key>NSExtensionActivationRule<\/key><string>/.test(plist), 'no predicate string')
  t.is(plistValue(xml, 'CFBundleDisplayName'), 'Varanda')
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    t.is(plistValue(xml, key), plistValue(read(INFO_PLIST), key), key + ' literal, the same as the app\'s')
  }
  t.is(compact(read(SHARE_PRIVACY_MANIFEST)), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>' +
    '<key>NSPrivacyAccessedAPITypes</key><array/><key>NSPrivacyCollectedDataTypes</key><array/><key>NSPrivacyTracking</key><false/>' +
    '</dict></plist>', SHARE_PRIVACY_MANIFEST + ': no tracking, no data, no required reason API')
})

// The extension only stores what was shared: it never opens the app (no
// responder chain walk, no extensionContext open) and never decodes an image.
test('the share extension never opens the app', (t) => {
  const source = read(SHARE_CONTROLLER)
  t.absent(source.includes('UIApplication'), 'no UIApplication')
  t.absent(source.includes('openURL'), 'no openURL')
  t.absent(/extensionContext\??\.open\b|\.next\b/.test(source), 'no extensionContext open, no responder chain')
  t.absent(/\bUIImage\s*\(|CGImageSource/.test(source), 'no image decode')
  t.absent(/\b(print|NSLog|debugPrint|os_log)\s*\(/.test(source), 'nothing logged')
  t.ok(source.includes('"Pronto. Abra o app Varanda para publicar."'), 'the done message')
  t.ok(source.includes('completeRequest(returningItems: [], completionHandler: nil)'), 'completes the request')
})

test('the share extension keeps the earlier share until its own is complete', (t) => {
  const source = read(SHARE_CONTROLLER)
  const prepare = source.slice(source.indexOf('private func prepareEntry('), source.indexOf('private func complete('))
  t.ok(prepare.length > 0, 'prepareEntry before complete')
  t.absent(prepare.includes('removeItem') || prepare.includes('dropOlder'), 'no share is dropped for being older before the new one loads')
  t.ok(prepare.includes('let expired = Self.prefixMs(id) - Self.ttlMs'), 'expiry is measured from the new id')
  t.ok(/if let at = Int64\(name\.prefix\(13\)\), name\.count > 13, at < expired \{\s*Self\.drop\(/.test(prepare), 'only expired entries go before the new share loads')
  t.is((prepare.match(/Self\.drop\(/g) || []).length, 1, 'and nothing else is dropped there')
  const complete = source.slice(source.indexOf('private func complete('), source.indexOf('private func dropOlder('))
  const rename = complete.indexOf('try fm.moveItem(at: tmp, to: entry.appendingPathComponent(Self.manifestName')
  t.ok(rename > 0 && complete.indexOf('dropOlder(than: id') > rename, 'older entries go after the manifest rename')
  t.ok(source.includes('where name < id'), 'only older entries go')
})

test('the share extension keeps words put on the item itself as the title', (t) => {
  const source = read(SHARE_CONTROLLER)
  t.ok(source.includes('$0.attributedContentText?.string'), 'reads the item text')
  t.ok(source.includes('guard !kinds.isEmpty || !title.isEmpty,'), 'a share with only that text is kept')
  t.ok(source.includes('"title": title,'), 'written as the title')
})

test('a file the source app hands over is copied or skipped, never read into memory', (t) => {
  const source = read(SHARE_CONTROLLER)
  const load = source.slice(source.indexOf('private func loadImage('), source.indexOf('private func loadURL('))
  const fallback = load.indexOf('provider.loadDataRepresentation')
  const handed = load.slice(load.indexOf('if let url = url {'), fallback)
  t.ok(fallback > 0 && handed.includes('self.copyFile(url, to: target)'), 'a handed file is copied')
  t.ok(/done\(\)\s*return\s*}\s*\/\/ Some apps only offer the bytes/.test(handed), 'and the bytes fallback is not reached')
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
  const generatedEntitlements = entitlements(fs.readFileSync(path.join(dir, ENTITLEMENTS), 'utf8'))
  t.alike(generatedEntitlements, entitlements(read(ENTITLEMENTS)), ENTITLEMENTS)
  t.alike(generatedEntitlements.groups, [APP_GROUP], ENTITLEMENTS + ' carries the app group from app.json')
  t.is(JSON.parse(fs.readFileSync(path.join(dir, PODFILE_PROPERTIES), 'utf8'))['ios.deploymentTarget'], IOS_MINIMUM, PODFILE_PROPERTIES)
  // The plugin sets the app target only, which overrides the project's value.
  const generatedTargets = fs.readFileSync(path.join(dir, PBXPROJ), 'utf8').match(/IPHONEOS_DEPLOYMENT_TARGET = [^;]*;/g)
  t.is(generatedTargets.filter((line) => line === DEPLOYMENT_TARGET_LINE).length, 2, PBXPROJ + ' app target, Debug and Release')
  const manifest = fs.readFileSync(path.join(dir, ANDROID_MANIFEST), 'utf8')
  t.ok(manifest.includes(RECORD_AUDIO_LINE), ANDROID_MANIFEST + ' asks for RECORD_AUDIO')
  t.ok(manifest.includes(CAMERA_REMOVED), ANDROID_MANIFEST + ' removes CAMERA')
})
