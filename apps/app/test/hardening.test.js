'use strict'

// plugins/with-hardening.js: the hand edits of ios/ and android/ that a
// prebuild --clean drops (backup exclusion, release signing, .debug suffix,
// ABI list). The last test runs a real `expo prebuild --clean --no-install`
// in a temp copy of the app (never in apps/app: prebuild would overwrite
// ios/ and android/) and compares the three patched files with the committed
// ones.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('brittle')
const { patchAppDelegate, patchBuildGradle, patchGradleProperties } = require('../plugins/hardening-patches')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const APP_DELEGATE = 'ios/Varanda/AppDelegate.swift'
const BUILD_GRADLE = 'android/app/build.gradle'
const GRADLE_PROPERTIES = 'android/gradle.properties'

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
})
