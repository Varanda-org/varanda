'use strict'

// modules/app-build: the installed Android build and whether Google Play
// installed it. The JS side loads its native module inside a guard, so in
// Node (as on web and iOS) it has none; the tests reach the guarded require
// through globalThis.require, which an ES module falls back to.
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('brittle')

const MODULE = path.join(__dirname, '../modules/app-build')
const moduleHref = pathToFileURL(path.join(MODULE, 'index.js')).href
let nonce = 0
const load = () => import(moduleHref + '?n=' + (++nonce))

async function withRequire (fake, fn) {
  const had = Object.hasOwn(globalThis, 'require')
  const previous = globalThis.require
  globalThis.require = fake
  try {
    return await fn()
  } finally {
    if (had) globalThis.require = previous
    else delete globalThis.require
  }
}

function expoCore (native) {
  return (name) => {
    if (name !== 'expo-modules-core') throw new Error('unexpected ' + name)
    return {
      requireNativeModule (moduleName) {
        if (moduleName !== 'AppBuild' || native === null) throw new Error('Cannot find native module')
        return native
      }
    }
  }
}

test('imports in Node and returns null without the native module', async (t) => {
  const m = await load()
  t.is(m.isAvailable(), false)
  t.is(m.appBuild(), null)
  const missing = await withRequire(expoCore(null), load)
  t.is(missing.isAvailable(), false, 'iOS and web: no AppBuild module')
  t.is(missing.appBuild(), null)
})

test('appBuild returns both values from the native module', async (t) => {
  const m = await withRequire(expoCore({ versionCode: 12, fromPlay: true }), load)
  t.is(m.isAvailable(), true)
  t.alike(m.appBuild(), { versionCode: 12, fromPlay: true })
  const side = await withRequire(expoCore({ versionCode: 1, fromPlay: false }), load)
  t.alike(side.appBuild(), { versionCode: 1, fromPlay: false })
})

test('buildOf validates both values', async (t) => {
  const { buildOf, MAX_VERSION_CODE } = await load()
  t.is(MAX_VERSION_CODE, 2100000000)
  t.alike(buildOf({ versionCode: 1, fromPlay: true }), { versionCode: 1, fromPlay: true })
  t.alike(buildOf({ versionCode: MAX_VERSION_CODE, fromPlay: false }), { versionCode: MAX_VERSION_CODE, fromPlay: false })
  for (const versionCode of [0, -1, 1.5, '5', null, undefined, NaN, MAX_VERSION_CODE + 1, 2 ** 53]) {
    t.is(buildOf({ versionCode, fromPlay: true }), null, 'versionCode ' + String(versionCode))
  }
  for (const fromPlay of ['true', 1, null, undefined, {}]) {
    t.is(buildOf({ versionCode: 5, fromPlay }), null, 'fromPlay ' + String(fromPlay))
  }
  const throwing = new Proxy({}, { get () { throw new Error('native') } })
  for (const source of [null, undefined, 5, 'x', throwing]) t.is(buildOf(source), null)
  const m = await withRequire(expoCore(throwing), load)
  t.is(m.appBuild(), null, 'a throwing native getter is no build')
})

test('autolinked on Android only, with no iOS side', (t) => {
  const config = JSON.parse(fs.readFileSync(path.join(MODULE, 'expo-module.config.json'), 'utf8'))
  t.alike(config, { platforms: ['android'], android: { modules: ['app.varanda.appbuild.AppBuildModule'] } })
  t.absent(fs.existsSync(path.join(MODULE, 'ios')), 'no ios folder')
  const pkg = JSON.parse(fs.readFileSync(path.join(MODULE, 'package.json'), 'utf8'))
  t.is(pkg.main, 'index.js')
  t.is(pkg.private, true)
  t.absent('dependencies' in pkg, 'no dependency of its own')
  // The resolver the build uses: Android links it, CocoaPods never sees it.
  const { ExpoModuleConfig } = require('expo-modules-autolinking/build/ExpoModuleConfig')
  const linked = new ExpoModuleConfig(config)
  t.ok(linked.supportsPlatform('android'))
  for (const platform of ['ios', 'apple', 'macos', 'tvos']) t.absent(linked.supportsPlatform(platform), platform)
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))
  t.absent(JSON.stringify(app).includes('app-build'), 'autolinked from modules/, not a package.json dependency')
  t.absent(JSON.stringify(app).includes('expo-application'), 'no expo-application')
  const podLock = fs.readFileSync(path.join(__dirname, '../ios/Podfile.lock'), 'utf8')
  t.absent(/AppBuild|app-build/.test(podLock), 'not in Podfile.lock')
})

test('the Kotlin module reads the installed versionCode and the Play installer', (t) => {
  const kotlin = fs.readFileSync(path.join(MODULE, 'android/src/main/java/app/varanda/appbuild/AppBuildModule.kt'), 'utf8')
  t.ok(kotlin.startsWith('package app.varanda.appbuild\n'))
  t.ok(kotlin.includes('class AppBuildModule : Module()'))
  t.ok(kotlin.includes('Name("AppBuild")'))
  t.ok(kotlin.includes('Constant("versionCode")'))
  t.ok(kotlin.includes('Constant("fromPlay")'))
  t.ok(kotlin.includes('.longVersionCode'))
  t.ok(kotlin.includes('getInstallSourceInfo(context.packageName).installingPackageName == PLAY_STORE'))
  t.ok(kotlin.includes('PLAY_STORE = "com.android.vending"'))
  t.absent(/android\.util\.Log|println|QUERY_ALL_PACKAGES/.test(kotlin), 'no logging and no package queries')
  const gradle = fs.readFileSync(path.join(MODULE, 'android/build.gradle'), 'utf8')
  t.ok(gradle.includes('namespace "app.varanda.appbuild"'))
  t.absent(/^dependencies/m.test(gradle), 'no dependency')
  // getInstallSourceInfo is API 30; the app's floor is above it.
  const props = fs.readFileSync(path.join(__dirname, '../android/gradle.properties'), 'utf8')
  const min = /^android\.minSdkVersion=(\d+)$/m.exec(props)
  t.ok(min && Number(min[1]) >= 30, 'minSdk covers getInstallSourceInfo')
})
