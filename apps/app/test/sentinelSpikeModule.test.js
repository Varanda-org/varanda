'use strict'

// modules/sentinel-spike/index.js (the JS side of the dev-only on-device
// model spike) with expo-modules-core replaced by a stub whose native module
// the tests swap through globalThis.__sentinelNative.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')

const expoCore = `
export function requireNativeModule (name) {
  if (name !== 'SentinelSpike') throw new Error('unknown module')
  return {
    isAvailable: () => globalThis.__sentinelNative.isAvailable(),
    load: (...args) => globalThis.__sentinelNative.load(...args),
    embed: (...args) => globalThis.__sentinelNative.embed(...args),
    memory: (...args) => globalThis.__sentinelNative.memory(...args),
    unload: (...args) => globalThis.__sentinelNative.unload(...args)
  }
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

const PIN = '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc'
const IDS = [0, 35378, 2]
const MASK = [1, 1, 1]

function unit (n = 384) {
  const v = new Array(n).fill(0)
  v[0] = 0.6
  v[1] = 0.8
  return v
}

const EMBEDDED = { vector: unit(), inferMs: 12.5 }

function fake (opts = {}) {
  const { available = true, error, answers = {} } = opts
  const throws = 'error' in opts
  const calls = []
  const answer = (name, fallback) => async (...args) => {
    calls.push([name, ...args])
    if (throws) throw error
    return name in answers ? answers[name] : fallback
  }
  globalThis.__sentinelNative = {
    isAvailable () {
      if (available instanceof Error) throw available
      return available
    },
    load: answer('load', { loadMs: 850.25, fileBytes: 118308126 }),
    embed: answer('embed', EMBEDDED),
    memory: answer('memory', { bytes: 210000000 }),
    unload: answer('unload', null)
  }
  return calls
}

async function rejection (t, promise) {
  try {
    await promise
    t.fail('should reject')
    return null
  } catch (err) {
    return err
  }
}

const load = () => import('../modules/sentinel-spike/index.js')

test('sentinel spike: validArgs takes one tokenized text of at most 128 tokens', async (t) => {
  const { validArgs, MAX_TOKENS, VOCAB_SIZE } = await load()
  t.is(MAX_TOKENS, 128)
  t.is(VOCAB_SIZE, 250002)
  t.ok(validArgs(IDS, MASK))
  t.ok(validArgs([5], [1]), 'one token')
  t.ok(validArgs(new Array(128).fill(7), new Array(128).fill(1)), '128 tokens')
  t.ok(validArgs([0, 250001, 2], [1, 1, 0]), 'the last vocabulary id, a padded position')
  const bad = [
    [[], []],
    [new Array(129).fill(7), new Array(129).fill(1)],
    [[0, 1, 2], [1, 1]],
    [[0, 1], [1, 1, 1]],
    [[0, -1, 2], MASK],
    [[0, 1.5, 2], MASK],
    [[0, '1', 2], MASK],
    [[0, NaN, 2], MASK],
    [[0, Infinity, 2], MASK],
    [[0, 250002, 2], MASK],
    [[0, 2 ** 53, 2], MASK],
    [IDS, [1, 2, 1]],
    [IDS, [1, 0.5, 1]],
    [IDS, [1, true, 1]],
    [IDS, [0, 0, 0]],
    [null, MASK],
    [IDS, null],
    ['0,1,2', '1,1,1'],
    [new Int32Array(IDS), MASK]
  ]
  for (const [ids, mask] of bad) t.absent(validArgs(ids, mask), JSON.stringify([ids, mask]))
})

test('sentinel spike: normalize keeps only 384 finite unit-length floats', async (t) => {
  const { normalize } = await load()
  t.alike(normalize(EMBEDDED), EMBEDDED)
  const copy = normalize({ ...EMBEDDED, extra: 'dropped' })
  t.alike(copy, EMBEDDED, 'cut to the contract fields')
  t.not(copy.vector, EMBEDDED.vector, 'a fresh array')
  t.alike(normalize({ vector: unit(), inferMs: 0 }), { vector: unit(), inferMs: 0 })
  const bad = [
    null,
    'ok',
    {},
    { inferMs: 1 },
    { vector: unit(383), inferMs: 1 },
    { vector: unit(385), inferMs: 1 },
    { vector: [...unit(383), NaN], inferMs: 1 },
    { vector: [...unit(383), '0'], inferMs: 1 },
    { vector: new Array(384).fill(0), inferMs: 1 },
    { vector: unit().map((v) => v * 2), inferMs: 1 },
    { vector: new Float32Array(unit()), inferMs: 1 },
    { vector: unit(), inferMs: -1 },
    { vector: unit(), inferMs: '12' },
    { vector: unit(), inferMs: Infinity }
  ]
  for (const answer of bad) t.is(normalize(answer), null)
})

test('sentinel spike: isAvailable never throws', async (t) => {
  const { isAvailable } = await load()
  fake({ available: true })
  t.is(isAvailable(), true)
  fake({ available: 'yes' })
  t.is(isAvailable(), false)
  fake({ available: null })
  t.is(isAvailable(), false)
  fake({ available: new Error('boom') })
  t.is(isAvailable(), false)
})

test('sentinel spike: an unavailable device rejects UNSUPPORTED before native', async (t) => {
  const mod = await load()
  for (const available of [false, new Error('boom')]) {
    const calls = fake({ available })
    for (const run of [() => mod.load(PIN, 2), () => mod.embed(IDS, MASK), () => mod.memory(), () => mod.unload()]) {
      const err = await rejection(t, run())
      t.is(err.code, 'UNSUPPORTED')
    }
    t.is(calls.length, 0)
  }
})

test('sentinel spike: load passes the pin and clamps threads to 1..4', async (t) => {
  const { load: loadModel } = await load()
  const calls = fake()
  t.alike(await loadModel(PIN, 2), { loadMs: 850.25, fileBytes: 118308126 })
  await loadModel(PIN)
  await loadModel(PIN, 0)
  await loadModel(PIN, -3)
  await loadModel(PIN, 9)
  t.alike(calls, [['load', PIN, 2], ['load', PIN, 1], ['load', PIN, 1], ['load', PIN, 1], ['load', PIN, 4]])
})

test('sentinel spike: load refuses a bad pin or thread count before native', async (t) => {
  const { load: loadModel } = await load()
  const calls = fake()
  const bad = [
    [undefined, 1],
    [PIN.toUpperCase(), 1],
    [PIN.slice(1), 1],
    [PIN + '0', 1],
    ['z' + PIN.slice(1), 1],
    [PIN, 1.5],
    [PIN, '2'],
    [PIN, NaN],
    [PIN, null]
  ]
  for (const args of bad) {
    const err = await rejection(t, loadModel(...args))
    t.is(err.code, 'INVALID')
  }
  t.is(calls.length, 0)
})

test('sentinel spike: a malformed load or memory answer rejects FAILED', async (t) => {
  const mod = await load()
  for (const answer of [null, {}, { loadMs: -1, fileBytes: 10 }, { loadMs: 1, fileBytes: 0 }, { loadMs: 1, fileBytes: 1.5 }, { loadMs: '1', fileBytes: 10 }]) {
    fake({ answers: { load: answer } })
    t.is((await rejection(t, mod.load(PIN, 1))).code, 'FAILED')
  }
  for (const answer of [null, {}, { bytes: 0 }, { bytes: -5 }, { bytes: 1.5 }, { bytes: '9' }]) {
    fake({ answers: { memory: answer } })
    t.is((await rejection(t, mod.memory())).code, 'FAILED')
  }
  fake()
  t.alike(await mod.memory(), { bytes: 210000000 })
  t.is(await mod.unload(), null)
})

test('sentinel spike: embed validates before native and sends copies', async (t) => {
  const { embed } = await load()
  const calls = fake()
  for (const [ids, mask] of [[[], []], [new Array(129).fill(1), new Array(129).fill(1)], [[0, -1], [1, 1]], [[0, 1.5], [1, 1]], [[0, 1], [1]]]) {
    t.is((await rejection(t, embed(ids, mask))).code, 'INVALID')
  }
  t.is(calls.length, 0)
  const ids = IDS.slice()
  t.alike(await embed(ids, MASK), EMBEDDED)
  t.alike(calls, [['embed', IDS, MASK]])
  t.not(calls[0][1], ids, 'native gets a copy')
})

test('sentinel spike: a vector that is not 384 unit floats rejects FAILED', async (t) => {
  const { embed } = await load()
  for (const answer of [null, { vector: unit(383), inferMs: 1 }, { vector: unit(512), inferMs: 1 }, { vector: new Array(384).fill(1), inferMs: 1 }, { vector: unit() }]) {
    fake({ answers: { embed: answer } })
    t.is((await rejection(t, embed(IDS, MASK))).code, 'FAILED')
  }
})

test('sentinel spike: native errors keep only known codes, with generic text', async (t) => {
  const mod = await load()
  const cases = [
    [Object.assign(new Error('native detail /var/x'), { code: 'PIN' }), 'PIN'],
    [Object.assign(new Error('native detail /var/x'), { code: 'MISSING' }), 'MISSING'],
    [Object.assign(new Error('native detail /var/x'), { code: 'BUSY' }), 'BUSY'],
    [Object.assign(new Error('native detail /var/x'), { code: 'NOT_LOADED' }), 'NOT_LOADED'],
    [Object.assign(new Error('native detail /var/x'), { code: 'INVALID' }), 'INVALID'],
    [Object.assign(new Error('native detail /var/x'), { code: 'UNSUPPORTED' }), 'UNSUPPORTED'],
    [Object.assign(new Error('native detail /var/x'), { code: 'FAILED' }), 'FAILED'],
    [Object.assign(new Error('native detail /var/x'), { code: 'ERR_ORT' }), 'FAILED'],
    [new Error('native detail /var/x'), 'FAILED'],
    ['native detail /var/x', 'FAILED'],
    [null, 'FAILED']
  ]
  for (const [error, code] of cases) {
    fake({ error })
    for (const run of [() => mod.load(PIN, 1), () => mod.embed(IDS, MASK), () => mod.memory(), () => mod.unload()]) {
      const err = await rejection(t, run())
      t.is(err.code, code)
      t.absent(err.message.includes('native detail'))
      t.absent(err.message.includes('/var/x'))
    }
  }
})

// Static checks on the native side and on who may import the module.
const fs = require('node:fs')
const path = require('node:path')

const APP = path.join(__dirname, '..')
const MODULE = path.join(APP, 'modules', 'sentinel-spike')
const SWIFT = path.join(MODULE, 'ios', 'SentinelSpikeModule.swift')
const KOTLIN = path.join(MODULE, 'android', 'src', 'main', 'java', 'app', 'varanda', 'sentinelspike', 'SentinelSpikeModule.kt')
const readText = (file) => fs.readFileSync(file, 'utf8')
// Line and block comments out, so prose about a guard or a logger counts for
// nothing.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const count = (text, needle) => text.split(needle).length - 1
// Whitespace runs collapsed to one space, so the checks do not depend on
// line breaks.
const flat = (text) => code(text).replace(/\s+/g, ' ')

test('native release gates: Release iOS and non-debuggable Android hosts answer UNSUPPORTED', (t) => {
  const swift = flat(readText(SWIFT))
  t.ok(swift.includes('#if DEBUG static let enabled = true #else static let enabled = false #endif'))
  t.ok(swift.includes('return SentinelSpikeModule.enabled'))
  t.is(count(swift, 'guard SentinelSpikeModule.enabled else { promise.reject("UNSUPPORTED", "unsupported") return }'), 4)
  t.is(count(swift, 'AsyncFunction('), 4)

  const kotlin = flat(readText(KOTLIN))
  t.ok(kotlin.includes('ApplicationInfo.FLAG_DEBUGGABLE'))
  t.ok(kotlin.includes('Function("isAvailable") { enabled() }'))
  t.is(count(kotlin, 'if (!enabled()) { promise.reject("UNSUPPORTED", "unsupported", null) return@AsyncFunction }'), 4)
  t.is(count(kotlin, 'AsyncFunction('), 4)
  t.absent(kotlin.includes('BuildConfig'))
  // One OrtEnvironment, created lazily with FATAL logging and reused.
  t.is(count(kotlin, 'OrtEnvironment.getEnvironment('), 1)
  t.ok(kotlin.includes('OrtEnvironment.getEnvironment(OrtLoggingLevel.ORT_LOGGING_LEVEL_FATAL'))
})

test('native sources log nothing', (t) => {
  const loggers = [/\bprint\s*\(/, /\bdebugPrint\s*\(/, /\bNSLog\b/, /\bos_log\b/, /\bLogger\s*\(/, /\bLog\.[a-z]+\s*\(/, /\bprintln\s*\(/, /\bTimber\b/, /System\.(out|err)\b/, /printStackTrace/]
  for (const file of [SWIFT, KOTLIN]) {
    const text = readText(file)
    for (const re of loggers) t.absent(re.test(text), `${path.basename(file)} matches ${re}`)
  }
})

test('module manifest and pinned native dependency versions', (t) => {
  const manifest = readText(path.join(MODULE, 'android', 'src', 'main', 'AndroidManifest.xml'))
  t.absent(manifest.includes('uses-permission'))

  const podspec = code(readText(path.join(MODULE, 'ios', 'SentinelSpike.podspec')).replace(/#.*$/gm, ''))
  t.ok(podspec.includes("s.dependency 'onnxruntime-objc', '1.21.0'"))
  t.is(count(podspec, 'onnxruntime'), 1)

  const gradle = code(readText(path.join(MODULE, 'android', 'build.gradle')))
  t.ok(/implementation\("com\.microsoft\.onnxruntime:onnxruntime-android"\)\s*\{\s*version\s*\{\s*strictly "1\.21\.1"\s*\}\s*\}/.test(gradle))
  t.is(count(gradle, 'onnxruntime'), 2)
  t.absent(/onnxruntime-android:\d/.test(gradle))
})

test('only src/sentinel/runBench.native.js imports modules/sentinel-spike', (t) => {
  const files = [path.join(APP, 'index.js')]
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(c|m)?(j|t)sx?$/.test(entry.name)) files.push(full)
    }
  }
  walk(path.join(APP, 'src'))
  t.ok(files.length > 1)
  const importers = files
    .filter((file) => readText(file).includes('sentinel-spike'))
    .map((file) => path.relative(APP, file).split(path.sep).join('/'))
  t.alike(importers, ['src/sentinel/runBench.native.js'])
})
