'use strict'

// modules/camera-capture/index.js (the system camera intent on Android) with
// expo-modules-core replaced by a stub whose native module the tests swap
// through globalThis.__cameraNative, plus source pins on the native side: no
// permission, a private provider, the grant revoked on return.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')

const expoCore = `
export function requireNativeModule (name) {
  if (name !== 'CameraCapture') throw new Error('unknown module')
  if (!globalThis.__cameraNative) throw new Error('missing')
  return globalThis.__cameraNative
}
`
const hooks = `
const stubs = {
  'expo-modules-core': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(expoCore)})
}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(__filename))

const MODULE_DIR = path.join(__dirname, '../modules/camera-capture')
const moduleHref = pathToFileURL(path.join(MODULE_DIR, 'index.js')).href
let nonce = 0
// Each import is a fresh copy: the module binds the native object once.
const load = () => import(moduleHref + '?n=' + (++nonce))

const HEX = '0123456789abcdef0123456789abcdef'
const DIR = 'file:///data/user/0/app.varanda/cache/CameraCapture/'
const PHOTO = { uri: DIR + HEX + '.jpg', kind: 'photo', mimeType: 'image/jpeg', width: 3024, height: 4032 }
const VIDEO = { uri: DIR + HEX + '.mp4', kind: 'video', mimeType: 'video/mp4' }

function fake (opts = {}) {
  // `in`, not a default: an explicit undefined answer is a case of its own.
  const answer = 'answer' in opts ? opts.answer : null
  const { fail = null, available = true } = opts
  const calls = { capture: [], isAvailable: [] }
  globalThis.__cameraNative = {
    isAvailable (kind) {
      calls.isAvailable.push(kind)
      if (typeof available === 'function') return available(kind)
      return Promise.resolve(available)
    },
    capture (kind, maxMs) {
      calls.capture.push([kind, maxMs])
      if (fail) {
        const err = new Error('/data/user/0/app.varanda/cache/secret native detail')
        err.code = fail
        return Promise.reject(err)
      }
      return Promise.resolve(answer)
    }
  }
  return calls
}

async function rejects (t, promise, code, label) {
  try {
    await promise
    t.fail(label + ': should reject')
  } catch (err) {
    t.ok(err instanceof Error, label + ': an Error')
    t.is(err.code, code, label)
    t.absent(/secret|\/data\//.test(err.message), label + ': no native text or path')
  }
}

test('camera capture: without the native module', async (t) => {
  globalThis.__cameraNative = null
  const mod = await load()
  t.is(mod.isAvailable(), false)
  t.alike(await mod.canCapture(), { photo: false, video: false })
  await rejects(t, mod.capture('photo'), 'UNAVAILABLE', 'capture')
  const err = await mod.capture('video').catch((e) => e)
  t.is(err.message, 'nenhum app de câmera foi encontrado')
})

test('camera capture: canCapture asks native per kind and never throws', async (t) => {
  const calls = fake({ available: (kind) => Promise.resolve(kind === 'photo') })
  let mod = await load()
  t.is(mod.isAvailable(), true)
  t.alike(await mod.canCapture(), { photo: true, video: false })
  t.alike(calls.isAvailable.sort(), ['photo', 'video'])

  fake({ available: () => { throw new Error('secret') } })
  mod = await load()
  t.alike(await mod.canCapture(), { photo: false, video: false }, 'a throwing native')

  fake({ available: () => Promise.resolve('yes') })
  mod = await load()
  t.alike(await mod.canCapture(), { photo: false, video: false }, 'only a true counts')
})

test('camera capture: accepts a valid photo and a valid video', async (t) => {
  let calls = fake({ answer: { ...PHOTO, extra: 'dropped' } })
  let mod = await load()
  t.alike(await mod.capture('photo', { maxMs: 15000 }), PHOTO)
  t.alike(calls.capture, [['photo', null]], 'a photo sends no duration')

  calls = fake({ answer: { ...VIDEO, width: 1, height: 1 } })
  mod = await load()
  t.alike(await mod.capture('video', { maxMs: 15000 }), VIDEO)
  t.alike(calls.capture, [['video', 15000]])

  calls = fake({ answer: VIDEO })
  mod = await load()
  t.alike(await mod.capture('video'), VIDEO)
  t.alike(calls.capture, [['video', null]])
})

test('camera capture: null on cancel', async (t) => {
  fake({ answer: null })
  const mod = await load()
  t.is(await mod.capture('photo'), null)
  t.is(await mod.capture('video', { maxMs: 1000 }), null)
})

test('camera capture: rejects a malformed native answer', async (t) => {
  const bad = [
    ['traversal', { ...PHOTO, uri: DIR + '../' + HEX + '.jpg' }],
    ['traversal before the folder', { ...PHOTO, uri: 'file:///data/user/0/app.varanda/files/../cache/CameraCapture/' + HEX + '.jpg' }],
    ['dot segment', { ...PHOTO, uri: 'file:///data/user/0/app.varanda/cache/CameraCapture/./' + HEX + '.jpg' }],
    ['empty segment', { ...PHOTO, uri: 'file:///data/user/0/app.varanda/cache//CameraCapture/' + HEX + '.jpg' }],
    ['encoded segment', { ...PHOTO, uri: 'file:///data/user/0/app.varanda/cache/CameraCapture/%2e%2e/' + HEX + '.jpg' }],
    ['query', { ...PHOTO, uri: PHOTO.uri + '?x=1' }],
    ['wrong folder', { ...PHOTO, uri: 'file:///data/user/0/app.varanda/cache/ImagePicker/' + HEX + '.jpg' }],
    ['folder not in cache', { ...PHOTO, uri: 'file:///data/user/0/app.varanda/files/CameraCapture/' + HEX + '.jpg' }],
    ['nested deeper', { ...PHOTO, uri: DIR + 'sub/' + HEX + '.jpg' }],
    ['relative file uri', { ...PHOTO, uri: 'file://cache/CameraCapture/' + HEX + '.jpg' }],
    ['content scheme', { ...PHOTO, uri: 'content://app.varanda.cameracapture/capture/' + HEX + '.jpg' }],
    ['plain path', { ...PHOTO, uri: '/data/user/0/app.varanda/cache/CameraCapture/' + HEX + '.jpg' }],
    ['wrong extension for the kind', { ...PHOTO, uri: DIR + HEX + '.mp4' }],
    ['uppercase hex', { ...PHOTO, uri: DIR + HEX.toUpperCase() + '.jpg' }],
    ['short name', { ...PHOTO, uri: DIR + HEX.slice(1) + '.jpg' }],
    ['other name', { ...PHOTO, uri: DIR + 'photo.jpg' }],
    ['not a string', { ...PHOTO, uri: 42 }],
    ['wrong kind', { ...PHOTO, kind: 'video' }],
    ['wrong mime', { ...PHOTO, mimeType: 'image/png' }],
    ['zero width', { ...PHOTO, width: 0 }],
    ['fractional height', { ...PHOTO, height: 10.5 }],
    ['string width', { ...PHOTO, width: '3024' }],
    ['missing height', { ...PHOTO, height: undefined }],
    ['undefined answer', undefined],
    ['string answer', DIR + HEX + '.jpg']
  ]
  for (const [label, answer] of bad) {
    fake({ answer })
    const mod = await load()
    await rejects(t, mod.capture('photo'), 'FAILED', label)
  }
  for (const [label, answer] of [
    ['photo name for a video', { ...VIDEO, uri: DIR + HEX + '.jpg' }],
    ['video mime', { ...VIDEO, mimeType: 'video/quicktime' }],
    ['photo kind', { ...VIDEO, kind: 'photo' }]
  ]) {
    fake({ answer })
    const mod = await load()
    await rejects(t, mod.capture('video'), 'FAILED', label)
  }
})

test('camera capture: maps native codes and hides native text', async (t) => {
  for (const [code, expected, message] of [
    ['UNAVAILABLE', 'UNAVAILABLE', 'nenhum app de câmera foi encontrado'],
    ['BUSY', 'BUSY', 'a câmera já está aberta'],
    ['FAILED', 'FAILED', 'não foi possível usar a câmera'],
    ['INVALID', 'FAILED', 'não foi possível usar a câmera'],
    [undefined, 'FAILED', 'não foi possível usar a câmera']
  ]) {
    fake({ fail: code || 'X' })
    const mod = await load()
    const err = await mod.capture('photo').catch((e) => e)
    t.is(err.code, expected, String(code))
    t.is(err.message, message, String(code))
  }
  globalThis.__cameraNative = Object.defineProperty({}, 'capture', { get () { throw new Error('secret') } })
  const mod = await load()
  await rejects(t, mod.capture('photo'), 'FAILED', 'a throwing property')
})

test('camera capture: bad arguments fail before native', async (t) => {
  const calls = fake({ answer: PHOTO })
  const mod = await load()
  await rejects(t, mod.capture('audio'), 'FAILED', 'unknown kind')
  await rejects(t, mod.capture('constructor'), 'FAILED', 'prototype key')
  for (const maxMs of [0, -1, 1.5, '1000', NaN, Infinity, null]) {
    await rejects(t, mod.capture('video', { maxMs }), 'FAILED', 'maxMs ' + String(maxMs))
  }
  t.alike(calls.capture, [], 'native never called')
})

const read = (rel) => fs.readFileSync(path.join(MODULE_DIR, rel), 'utf8')

function walk (dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
}

const KOTLIN = 'android/src/main/java/app/varanda/cameracapture/'

test('camera capture: no permission anywhere in the module', (t) => {
  const manifest = read('android/src/main/AndroidManifest.xml')
  t.absent(manifest.includes('uses-permission'), 'manifest declares no permission')
  t.absent(/permission/i.test(manifest.replace(/<!--[\s\S]*?-->/g, '').replace(/grantUriPermissions/g, '')), 'no permission element of any kind')
  for (const file of walk(MODULE_DIR)) {
    const source = fs.readFileSync(file, 'utf8')
    t.absent(source.includes('CAMERA'), path.relative(MODULE_DIR, file) + ' never names the camera permission')
  }
  t.ok(manifest.includes('<action android:name="android.media.action.IMAGE_CAPTURE" />'), 'photo query')
  t.ok(manifest.includes('<action android:name="android.media.action.VIDEO_CAPTURE" />'), 'video query')
})

test('camera capture: the provider is private and limited to the capture folder', (t) => {
  const manifest = read('android/src/main/AndroidManifest.xml')
  const provider = /<provider[\s\S]*?<\/provider>/.exec(manifest)
  t.ok(provider, 'one provider')
  t.ok(provider[0].includes('android:exported="false"'), 'not exported')
  t.ok(provider[0].includes('android:grantUriPermissions="true"'), 'grants per Uri')
  t.ok(provider[0].includes('android:authorities="${applicationId}.cameracapture"'), 'own authority') // eslint-disable-line no-template-curly-in-string
  t.ok(provider[0].includes('android:name="app.varanda.cameracapture.CaptureFileProvider"'), 'own subclass')
  t.ok(provider[0].includes('android:resource="@xml/camera_capture_paths"'), 'its paths')
  const paths = read('android/src/main/res/xml/camera_capture_paths.xml')
  const entries = paths.match(/<[a-z-]+-path\b[^>]*>/g)
  t.alike(entries, ['<cache-path name="capture" path="CameraCapture/" />'], 'only the capture folder')
  t.ok(/class CaptureFileProvider : FileProvider\(\)/.test(read(KOTLIN + 'CaptureFileProvider.kt')))
})

test('camera capture: the native side writes through EXTRA_OUTPUT and revokes the grant', (t) => {
  const module = read(KOTLIN + 'CameraCaptureModule.kt')
  const contract = read(KOTLIN + 'CaptureContract.kt')
  const native = module + contract
  t.ok(contract.includes('putExtra(MediaStore.EXTRA_OUTPUT, uri)'), 'EXTRA_OUTPUT')
  t.ok(contract.includes('MediaStore.EXTRA_DURATION_LIMIT'), 'EXTRA_DURATION_LIMIT')
  t.ok(contract.includes('ClipData.newRawUri'), 'ClipData carries the grant')
  t.ok(contract.includes('Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION'), 'read and write grant')
  t.ok(module.includes('revokeUriPermission'), 'grant revoked')
  const deliver = module.slice(module.indexOf('private fun deliver('))
  t.ok(deliver.indexOf('revoke(input)') > 0 && deliver.indexOf('revoke(input)') < deliver.indexOf('backgroundCoroutineScope'), 'revoked as soon as the result arrives')
  t.ok(module.includes('OnActivityDestroys') && module.includes('pending != null && !hostLost'), 'a capture lost with its activity never leaves BUSY for good')
  t.ok(module.includes('val promise = take(input.path)') && module.includes('if (pendingPath != path) return@synchronized null'), 'a late result from an orphaned capture never answers the next one')
  t.ok(module.indexOf('pendingPath = out.absolutePath') < module.indexOf('launcher.launch(input)'), 'the awaited file is known before the camera opens')
  t.ok(module.includes('MAX_COPY = 512L * 1024 * 1024'), 'copy cap')
  t.ok(module.includes('STALE_MS = 24L * 60 * 60 * 1000'), 'sweep age')
  t.ok(module.includes('data.scheme != "content"'), 'only a content Uri is copied')
  t.ok(module.includes('ownAuthority(context, authority)'), 'never one of our own providers')
  t.ok(module.includes("authority.contains('@')"), 'a user@ authority is refused, Android strips it before dispatch')
  t.ok(module.includes('serving.packageName == context.packageName'), 'the provider that would serve the Uri is never ours')
  t.absent(/MediaStore\.(Images|Video)\.Media|insertImage|EXTERNAL_CONTENT_URI/.test(native), 'nothing written to the gallery')
  t.absent(/\bLog\.|println|printStackTrace/.test(native), 'never logs')
})

test('camera capture: android only, with exact versions', (t) => {
  const config = JSON.parse(read('expo-module.config.json'))
  t.alike(config.platforms, ['android'])
  t.alike(Object.keys(config).sort(), ['android', 'platforms'])
  t.alike(config.android.modules, ['app.varanda.cameracapture.CameraCaptureModule'])
  const pkg = JSON.parse(read('package.json'))
  t.is(pkg.name, 'camera-capture')
  t.is(pkg.private, true)
  t.is(pkg.main, 'index.js')
  const gradle = read('android/build.gradle')
  t.ok(gradle.includes('namespace "app.varanda.cameracapture"'))
  const deps = gradle.match(/^\s*implementation\s+"[^"]+"/gm) || []
  t.ok(deps.length > 0, 'declares its dependencies')
  for (const line of deps) {
    t.ok(/"[\w.-]+:[\w.-]+:\d+\.\d+\.\d+"$/.test(line.trim()), line.trim() + ' is exact')
  }
  t.absent(/[+[\]]|latest/.test(gradle.split('dependencies')[1]), 'no dynamic or range version')
  t.ok(gradle.includes('implementation "androidx.activity:activity-ktx:1.11.0"'))
})
