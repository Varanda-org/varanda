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
    classify: (...args) => globalThis.__sentinelNative.classify(...args),
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
const CLASSIFIED = { logits: [2.5, -0.75, -1.25], inferMs: 30.5 }
const PAIR = [0, 35378, 2, 2, 581, 2]
const PAIR_MASK = [1, 1, 1, 1, 1, 1]
const PAIR_TYPES = [0, 0, 0, 1, 1, 1]

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
    classify: answer('classify', CLASSIFIED),
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
    for (const run of [() => mod.load('embed', PIN, 2), () => mod.load('nli', PIN, 2), () => mod.embed(IDS, MASK), () => mod.classify(PAIR, PAIR_MASK), () => mod.memory(), () => mod.unload()]) {
      const err = await rejection(t, run())
      t.is(err.code, 'UNSUPPORTED')
    }
    t.is(calls.length, 0)
  }
})

test('sentinel spike: load passes the model key and the pin and clamps threads to 1..4', async (t) => {
  const { load: loadModel, MODELS } = await load()
  t.alike(MODELS, ['embed', 'nli'])
  t.ok(Object.isFrozen(MODELS))
  const calls = fake()
  t.alike(await loadModel('embed', PIN, 2), { loadMs: 850.25, fileBytes: 118308126 })
  await loadModel('embed', PIN)
  await loadModel('nli', PIN, 0)
  await loadModel('nli', PIN, -3)
  await loadModel('embed', PIN, 9)
  t.alike(calls, [['load', 'embed', PIN, 2], ['load', 'embed', PIN, 1], ['load', 'nli', PIN, 1], ['load', 'nli', PIN, 1], ['load', 'embed', PIN, 4]])
})

test('sentinel spike: load takes only an allowlisted model key, never a path', async (t) => {
  const { load: loadModel } = await load()
  const calls = fake()
  const bad = [
    undefined,
    null,
    '',
    'NLI',
    'Embed',
    ' nli',
    'nli\0',
    'model_quantized.onnx',
    'nli_quantized.onnx',
    'sentinel/nli_quantized.onnx',
    '../nli',
    '/data/data/app.varanda.debug/files/sentinel/x.onnx',
    'file:///tmp/x.onnx',
    'https://example.invalid/x.onnx',
    'toString',
    '__proto__',
    'constructor',
    ['nli'],
    { toString: () => 'nli' },
    1
  ]
  for (const model of bad) {
    const err = await rejection(t, loadModel(model, PIN, 1))
    t.is(err.code, 'INVALID', String(model))
  }
  t.is(calls.length, 0)
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
    const err = await rejection(t, loadModel('nli', ...args))
    t.is(err.code, 'INVALID')
  }
  t.is(calls.length, 0)
})

test('sentinel spike: a malformed load or memory answer rejects FAILED', async (t) => {
  const mod = await load()
  for (const answer of [null, {}, { loadMs: -1, fileBytes: 10 }, { loadMs: 1, fileBytes: 0 }, { loadMs: 1, fileBytes: 1.5 }, { loadMs: '1', fileBytes: 10 }]) {
    fake({ answers: { load: answer } })
    t.is((await rejection(t, mod.load('nli', PIN, 1))).code, 'FAILED')
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

test('sentinel spike: validPairArgs takes one pair of at most 256 tokens and optional 0/1 token types', async (t) => {
  const { validPairArgs, validArgs, MAX_NLI_TOKENS, NLI_VOCAB_SIZE } = await load()
  t.is(MAX_NLI_TOKENS, 256)
  // The on-device MiniLM NLI model's vocabulary (xlm-roberta), not
  // mDeBERTa's 251000, which runs only in Node.
  t.is(NLI_VOCAB_SIZE, 250002)
  t.ok(validPairArgs(PAIR, PAIR_MASK))
  t.ok(validPairArgs(PAIR, PAIR_MASK, undefined))
  t.ok(validPairArgs(PAIR, PAIR_MASK, null))
  t.ok(validPairArgs(PAIR, PAIR_MASK, PAIR_TYPES))
  t.ok(validPairArgs(new Array(256).fill(7), new Array(256).fill(1)), '256 tokens')
  t.absent(validArgs(new Array(256).fill(7), new Array(256).fill(1)), 'embed keeps 128')
  t.ok(validPairArgs([0, 250001, 2], [1, 1, 1]), 'the last id of the on-device NLI vocabulary')
  const bad = [
    [[], [], undefined],
    [new Array(257).fill(7), new Array(257).fill(1), undefined],
    [[0, 250002, 2], [1, 1, 1], undefined],
    [[0, 250999, 2], [1, 1, 1], undefined],
    [[0, 251000, 2], [1, 1, 1], undefined],
    [[0, -1, 2], [1, 1, 1], undefined],
    [[0, 1.5, 2], [1, 1, 1], undefined],
    [[0, '1', 2], [1, 1, 1], undefined],
    [[0, 1, 2], [1, 2, 1], undefined],
    [[0, 1, 2], [0, 0, 0], undefined],
    [[0, 1, 2], [1, 1], undefined],
    [PAIR, PAIR_MASK, [0, 0, 1]],
    [PAIR, PAIR_MASK, [...PAIR_TYPES, 1]],
    [PAIR, PAIR_MASK, [0, 0, 0, 2, 1, 1]],
    [PAIR, PAIR_MASK, [0, 0, 0, 0.5, 1, 1]],
    [PAIR, PAIR_MASK, [0, 0, 0, '1', 1, 1]],
    [PAIR, PAIR_MASK, [0, 0, 0, true, 1, 1]],
    [PAIR, PAIR_MASK, '000111'],
    [PAIR, PAIR_MASK, new Int32Array(PAIR_TYPES)],
    [PAIR, PAIR_MASK, {}],
    [PAIR, PAIR_MASK, 0]
  ]
  for (const [ids, mask, types] of bad) t.absent(validPairArgs(ids, mask, types), JSON.stringify([ids, mask, types]))
})

test('sentinel spike: normalizeLogits keeps only 2 to 8 finite floats', async (t) => {
  const { normalizeLogits } = await load()
  t.alike(normalizeLogits(CLASSIFIED), CLASSIFIED)
  const copy = normalizeLogits({ ...CLASSIFIED, extra: 'dropped' })
  t.alike(copy, CLASSIFIED, 'cut to the contract fields')
  t.not(copy.logits, CLASSIFIED.logits, 'a fresh array')
  t.alike(normalizeLogits({ logits: [0, 0], inferMs: 0 }), { logits: [0, 0], inferMs: 0 })
  t.alike(normalizeLogits({ logits: new Array(8).fill(-3), inferMs: 1 }), { logits: new Array(8).fill(-3), inferMs: 1 })
  const bad = [
    null,
    'ok',
    {},
    { inferMs: 1 },
    { logits: [1], inferMs: 1 },
    { logits: new Array(9).fill(0), inferMs: 1 },
    { logits: [1, NaN, 0], inferMs: 1 },
    { logits: [1, Infinity, 0], inferMs: 1 },
    { logits: [1, '0', 0], inferMs: 1 },
    { logits: [[1, 0, 0]], inferMs: 1 },
    { logits: new Float32Array([1, 0, 0]), inferMs: 1 },
    { logits: [1, 0, 0], inferMs: -1 },
    { logits: [1, 0, 0], inferMs: '1' },
    { logits: [1, 0, 0] }
  ]
  for (const answer of bad) t.is(normalizeLogits(answer), null, JSON.stringify(answer))
})

test('sentinel spike: classify validates before native and sends copies, null for absent types', async (t) => {
  const { classify } = await load()
  const calls = fake()
  for (const [ids, mask, types] of [[[], []], [new Array(257).fill(1), new Array(257).fill(1)], [PAIR, PAIR_MASK, [0, 1]], [PAIR, PAIR_MASK, [0, 0, 0, 2, 1, 1]], [[0, 250002], [1, 1]]]) {
    t.is((await rejection(t, classify(ids, mask, types))).code, 'INVALID')
  }
  t.is(calls.length, 0)
  const ids = PAIR.slice()
  const types = PAIR_TYPES.slice()
  t.alike(await classify(ids, PAIR_MASK, types), CLASSIFIED)
  t.alike(await classify(ids, PAIR_MASK), CLASSIFIED)
  t.alike(await classify(ids, PAIR_MASK, null), CLASSIFIED)
  t.alike(calls, [['classify', PAIR, PAIR_MASK, PAIR_TYPES], ['classify', PAIR, PAIR_MASK, null], ['classify', PAIR, PAIR_MASK, null]])
  t.not(calls[0][1], ids, 'native gets a copy of the ids')
  t.not(calls[0][3], types, 'native gets a copy of the types')
})

test('sentinel spike: malformed logits reject FAILED', async (t) => {
  const { classify } = await load()
  for (const answer of [null, { logits: [1], inferMs: 1 }, { logits: new Array(9).fill(0), inferMs: 1 }, { logits: [1, NaN, 0], inferMs: 1 }, { logits: [1, 0, 0] }, EMBEDDED]) {
    fake({ answers: { classify: answer } })
    t.is((await rejection(t, classify(PAIR, PAIR_MASK))).code, 'FAILED')
  }
})

test('sentinel spike: WRONG_MODEL from native reaches the caller', async (t) => {
  const mod = await load()
  fake({ error: Object.assign(new Error('x'), { code: 'WRONG_MODEL' }) })
  for (const run of [() => mod.embed(IDS, MASK), () => mod.classify(PAIR, PAIR_MASK)]) {
    const err = await rejection(t, run())
    t.is(err.code, 'WRONG_MODEL')
    t.is(err.message, 'o modelo carregado não faz esta operação')
  }
})

test('sentinel spike: native errors keep only known codes, with generic text', async (t) => {
  const mod = await load()
  const cases = [
    [Object.assign(new Error('native detail /var/x'), { code: 'PIN' }), 'PIN'],
    [Object.assign(new Error('native detail /var/x'), { code: 'MISSING' }), 'MISSING'],
    [Object.assign(new Error('native detail /var/x'), { code: 'BUSY' }), 'BUSY'],
    [Object.assign(new Error('native detail /var/x'), { code: 'NOT_LOADED' }), 'NOT_LOADED'],
    [Object.assign(new Error('native detail /var/x'), { code: 'WRONG_MODEL' }), 'WRONG_MODEL'],
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
    for (const run of [() => mod.load('embed', PIN, 1), () => mod.embed(IDS, MASK), () => mod.classify(PAIR, PAIR_MASK, PAIR_TYPES), () => mod.memory(), () => mod.unload()]) {
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
const INDEX = path.join(MODULE, 'index.js')
const KOTLIN = path.join(MODULE, 'android', 'src', 'main', 'java', 'app', 'varanda', 'sentinelspike', 'SentinelSpikeModule.kt')
const readText = (file) => fs.readFileSync(file, 'utf8')
// Line and block comments out, so prose about a guard or a logger counts for
// nothing.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const count = (text, needle) => text.split(needle).length - 1
// Whitespace runs collapsed to one space, so the checks do not depend on
// line breaks.
const flat = (text) => code(text).replace(/\s+/g, ' ')
// String literals emptied, so a rejection message is not an identifier.
const noStrings = (text) => text.replace(/"[^"]*"/g, '""')

test('native release gates: Release iOS and non-debuggable Android hosts answer UNSUPPORTED', (t) => {
  const swift = flat(readText(SWIFT))
  t.ok(swift.includes('#if DEBUG static let enabled = true #else static let enabled = false #endif'))
  t.ok(swift.includes('return SentinelSpikeModule.enabled'))
  t.is(count(swift, 'guard SentinelSpikeModule.enabled else { promise.reject("UNSUPPORTED", "unsupported") return }'), 5)
  t.is(count(swift, 'AsyncFunction('), 5)
  // The only other registered function is isAvailable, and the module has no
  // property, constant or event that could answer without the gate.
  t.is(count(swift, 'Function('), 5 + 1)
  t.is(count(swift, 'Function("isAvailable")'), 1)
  // Every AsyncFunction closure starts with the gate: the first statement
  // after its parameter list.
  const swiftBlocks = swift.split('AsyncFunction(').slice(1)
  t.is(swiftBlocks.filter((b) => /^"\w+"\) \{ \([^)]*\) in guard SentinelSpikeModule\.enabled else \{ promise\.reject\("UNSUPPORTED", "unsupported"\) return \}/.test(b)).length, 5)
  for (const re of [/\bProperty\s*\(/, /\bConstants\s*\(/, /\bEvents\s*\(/]) t.absent(re.test(swift), `swift matches ${re}`)

  const kotlin = flat(readText(KOTLIN))
  t.ok(kotlin.includes('ApplicationInfo.FLAG_DEBUGGABLE'))
  t.ok(kotlin.includes('Function("isAvailable") { enabled() }'))
  t.is(count(kotlin, 'if (!enabled()) { promise.reject("UNSUPPORTED", "unsupported", null) return@AsyncFunction }'), 5)
  t.is(count(kotlin, 'AsyncFunction('), 5)
  t.is(count(kotlin, 'Function('), 5 + 1)
  t.is(count(kotlin, 'Function("isAvailable")'), 1)
  const kotlinBlocks = kotlin.split('AsyncFunction(').slice(1)
  t.is(kotlinBlocks.filter((b) => /^"\w+"\) \{ [^{}]*? -> if \(!enabled\(\)\) \{ promise\.reject\("UNSUPPORTED", "unsupported", null\) return@AsyncFunction \}/.test(b)).length, 5)
  for (const re of [/\bProperty\s*\(/, /\bConstants\s*\(/, /\bEvents\s*\(/]) t.absent(re.test(kotlin), `kotlin matches ${re}`)
  t.absent(kotlin.includes('BuildConfig'))
  // One OrtEnvironment, created lazily with FATAL logging and reused.
  t.is(count(kotlin, 'OrtEnvironment.getEnvironment('), 1)
  t.ok(kotlin.includes('OrtEnvironment.getEnvironment(OrtLoggingLevel.ORT_LOGGING_LEVEL_FATAL'))
  // One ORTEnv on iOS too, a static let at FATAL.
  t.is(count(swift, 'ORTEnv('), 1)
  t.ok(swift.includes('private static let env: ORTEnv? = try? ORTEnv(loggingLevel: .fatal)'))
})

test('native model allowlist: two fixed keys, each with a fixed file name and output', (t) => {
  const swift = flat(readText(SWIFT))
  t.ok(swift.includes('switch key { case "embed": return .embed case "nli": return .nli default: return nil }'))
  t.ok(swift.includes('case .embed: return "model_quantized.onnx" case .nli: return "nli_quantized.onnx"'))
  t.ok(swift.includes('case .embed: return "last_hidden_state" case .nli: return "logits"'))
  t.is(count(swift, '.onnx"'), 2)

  const kotlin = flat(readText(KOTLIN))
  t.ok(kotlin.includes('EMBED("embed", "model_quantized.onnx", "last_hidden_state"), NLI("nli", "nli_quantized.onnx", "logits");'))
  t.ok(kotlin.includes('fun named(key: String): Kind? = values().firstOrNull { it.key == key }'))
  t.is(count(kotlin, '.onnx"'), 2)

  const js = flat(readText(INDEX))
  t.ok(js.includes("export const MODELS = Object.freeze(['embed', 'nli'])"))
  t.ok(js.includes("if (typeof model !== 'string' || !MODELS.includes(model)) throw fail('INVALID')"))
  t.absent(js.includes('.onnx'), 'index.js names no file')
  t.absent(/\bconsole\./.test(js), 'index.js logs nothing')
  t.absent(/\bfetch\s*\(/.test(js), 'index.js touches no network')
})

test('native load takes a model key, a pin and a thread count, and builds no path from JS', (t) => {
  const swift = flat(readText(SWIFT))
  t.ok(swift.includes('AsyncFunction("load") { (model: String, expected: String, threads: Double, promise: Promise) in'))
  // The JS string is used once: the allowlist lookup.
  t.is(noStrings(swift).match(/\bmodel\b/g).length, 2)
  t.ok(swift.includes('guard let kind = SentinelSpikeKind.named(model),'))
  // The only path: Documents, then "sentinel", then the key's fixed name.
  t.ok(swift.includes('.appendingPathComponent("sentinel", isDirectory: true) .appendingPathComponent(kind.fileName, isDirectory: false)'))
  t.is(count(swift, 'appendingPathComponent('), 2)
  t.is(count(swift, 'SentinelSpikeModule.modelURL(kind)'), 1)
  for (const re of [/fileURLWithPath/, /URL\(string/, /URLSession/, /NSString\(string/, /\bpath: String\b(?!, threads)/]) {
    t.absent(re.test(swift), `swift matches ${re}`)
  }
  // Each other JS-facing function takes only numbers.
  t.ok(swift.includes('AsyncFunction("embed") { (ids: [Double], mask: [Double], promise: Promise) in'))
  t.ok(swift.includes('AsyncFunction("classify") { (ids: [Double], mask: [Double], typeIds: [Double]?, promise: Promise) in'))

  const kotlin = flat(readText(KOTLIN))
  t.ok(kotlin.includes('AsyncFunction("load") { model: String, expected: String, threads: Double, promise: Promise ->'))
  t.is(noStrings(kotlin).match(/\bmodel\b/g).length, 2)
  t.ok(kotlin.includes('val kind = Kind.named(model)'))
  t.ok(kotlin.includes('if (kind == null || !isSha256Hex(expected)'))
  t.ok(kotlin.includes('val file = File(File(filesDir, DIR), kind.fileName)'))
  t.is(count(kotlin, 'File('), 3, 'the model file and its directory, plus Files.isRegularFile')
  t.is(count(kotlin, 'FileInputStream('), 1)
  for (const re of [/Uri\.parse/, /\bURL\(/, /HttpURLConnection/, /openConnection/, /Socket/]) {
    t.absent(re.test(kotlin), `kotlin matches ${re}`)
  }
  t.ok(kotlin.includes('AsyncFunction("embed") { ids: List<Double>, mask: List<Double>, promise: Promise ->'))
  t.ok(kotlin.includes('AsyncFunction("classify") { ids: List<Double>, mask: List<Double>, typeIds: List<Double>?, promise: Promise ->'))

  // The pin is checked before the session is created, on both sides.
  const swiftLoad = swift.slice(swift.indexOf('AsyncFunction("load")'), swift.indexOf('AsyncFunction("embed")'))
  t.ok(swiftLoad.indexOf('checkPin(url, expected)') < swiftLoad.indexOf('SentinelSpikeRuntime(kind: kind'))
  t.ok(swiftLoad.indexOf('self.runtime = nil') < swiftLoad.indexOf('checkPin(url, expected)'), 'the old session goes first')
  const kotlinLoad = kotlin.slice(kotlin.indexOf('AsyncFunction("load")'), kotlin.indexOf('AsyncFunction("embed")'))
  t.ok(kotlinLoad.indexOf('checkPin(file, expected)') < kotlinLoad.indexOf('loaded = open(file, count, kind)'))
  t.ok(kotlinLoad.indexOf('closeLoaded()') < kotlinLoad.indexOf('checkPin(file, expected)'), 'the old session goes first')
})

test('native classify: nli only, raw [1, k] logits with 2 <= k <= 8, 256 tokens', (t) => {
  const swift = flat(readText(SWIFT))
  t.ok(swift.includes('static let maxTokens = 128'))
  t.ok(swift.includes('static let maxPairTokens = 256'))
  t.ok(swift.includes('static let minLabels = 2'))
  t.ok(swift.includes('static let maxLabels = 8'))
  t.ok(swift.includes('static let nliVocabSize = 250_002'))
  t.ok(swift.includes('guard runtime.kind == .nli else { self.end() promise.reject("WRONG_MODEL", "wrong model") return }'))
  t.ok(swift.includes('guard runtime.kind == .embed else { self.end() promise.reject("WRONG_MODEL", "wrong model") return }'))
  t.ok(swift.includes('guard info.elementType == .float, dims.count == 2, dims[0] == 1, dims[1] >= SentinelSpikeModule.minLabels, dims[1] <= SentinelSpikeModule.maxLabels else {'))
  t.ok(swift.includes('guard f.isFinite else { throw SentinelSpikeError.failed }'))
  t.ok(swift.includes('try session.outputNames().contains(kind.output)'))
  t.ok(swift.includes('maxTokens: SentinelSpikeModule.maxPairTokens, vocabSize: SentinelSpikeModule.nliVocabSize'))
  t.ok(swift.includes('maxTokens: SentinelSpikeModule.maxTokens, vocabSize: SentinelSpikeModule.vocabSize'))

  const kotlin = flat(readText(KOTLIN))
  t.ok(kotlin.includes('private const val MAX_TOKENS = 128'))
  t.ok(kotlin.includes('private const val MAX_PAIR_TOKENS = 256'))
  t.ok(kotlin.includes('private const val MIN_LABELS = 2'))
  t.ok(kotlin.includes('private const val MAX_LABELS = 8'))
  t.ok(kotlin.includes('private const val NLI_VOCAB_SIZE = 250_002'))
  t.ok(kotlin.includes('if (current.kind != Kind.NLI) return@submit Answer.Reject("WRONG_MODEL")'))
  t.ok(kotlin.includes('if (current.kind != Kind.EMBED) return@submit Answer.Reject("WRONG_MODEL")'))
  t.ok(kotlin.includes('if (info.type != OnnxJavaType.FLOAT || dims.size != 2 || dims[0] != 1L || dims[1] < MIN_LABELS.toLong() || dims[1] > MAX_LABELS.toLong()) {'))
  t.ok(kotlin.includes('if (!v.isFinite()) throw IllegalStateException()'))
  t.ok(kotlin.includes('kind.output !in session.outputNames'))
  t.ok(kotlin.includes('tokens(ids, mask, MAX_PAIR_TOKENS, NLI_VOCAB_SIZE)'))
  t.ok(kotlin.includes('tokens(ids, mask, MAX_TOKENS, VOCAB_SIZE)'))

  // mDeBERTa's larger table (251000) is no bound anywhere: the device runs
  // only the MiniLM NLI model, so the three sides agree on 250002.
  t.ok(flat(readText(INDEX)).includes('export const NLI_VOCAB_SIZE = 250002'))
  for (const [name, text] of [['swift', swift], ['kotlin', kotlin], ['index.js', flat(readText(INDEX))]]) {
    t.absent(/\b251_?000\b/.test(text), `${name} has no 251000 bound`)
  }

  // One operation at a time: every queued function goes through the busy
  // gate.
  t.is(count(swift, 'guard self.begin() else { promise.reject("BUSY", "busy") return }'), 4)
  t.is(count(kotlin, 'submit(promise) {'), 4)
})

test('native input guards: ids below the vocabulary, 0/1 mask and token types, same lengths', (t) => {
  const swift = flat(readText(SWIFT))
  t.is(count(swift, 'guard !ids.isEmpty, ids.count <= maxTokens, ids.count == mask.count else { return nil }'), 1)
  t.is(count(swift, 'guard id.isFinite, id == id.rounded(), id >= 0, id < Double(vocabSize) else { return nil }'), 1)
  t.is(count(swift, 'guard let outMask = SentinelSpikeTokens.bits(mask), outMask.contains(1) else { return nil }'), 1)
  t.is(count(swift, 'guard typeIds.count == ids.count, let bits = SentinelSpikeTokens.bits(typeIds) else { return nil }'), 1)
  t.is(count(swift, 'guard v == 0 || v == 1 else { return nil }'), 1)
  // Both entry points build their tokens through the guarded initializer.
  t.is(count(swift, 'SentinelSpikeTokens(ids: ids, mask: mask,'), 2)
  t.is(count(swift, 'promise.reject("INVALID", "invalid")'), 3)
  // The session takes only the three known int64 inputs.
  t.ok(swift.includes('let known: Set<String> = ["input_ids", "attention_mask", "token_type_ids"]'))
  t.ok(swift.includes('guard inputs.isSubset(of: known), inputs.contains("input_ids"), inputs.contains("attention_mask"),'))

  const kotlin = flat(readText(KOTLIN))
  t.is(count(kotlin, 'if (ids.isEmpty() || ids.size > maxTokens || ids.size != mask.size) return null'), 1)
  t.is(count(kotlin, 'if (!id.isFinite() || id != Math.rint(id) || id < 0 || id >= vocabSize) return null'), 1)
  t.is(count(kotlin, 'val outMask = bits(mask) ?: return null'), 1)
  t.is(count(kotlin, 'if (outMask.none { it == 1L }) return null'), 1)
  t.is(count(kotlin, 'if (v != 0.0 && v != 1.0) return null'), 1)
  t.is(count(kotlin, 'val types = typeIds?.let { bits(it) }'), 1)
  t.is(count(kotlin, 'if (tokens == null || (typeIds != null && (types == null || types.size != ids.size))) {'), 1)
  t.is(count(kotlin, 'val tokens = tokens('), 2)
  t.is(count(kotlin, 'promise.reject("INVALID", "invalid", null)'), 3)
  t.ok(kotlin.includes('val known = setOf("input_ids", "attention_mask", "token_type_ids")'))
  t.ok(kotlin.includes('val int64 = inputs.values.all { (it.info as? TensorInfo)?.type == OnnxJavaType.INT64 }'))
  t.ok(kotlin.includes('if (!known.containsAll(inputs.keys) || !inputs.containsKey("input_ids") || !inputs.containsKey("attention_mask") || !int64 || kind.output !in session.outputNames) {'))
})

test('native model file: a regular file, never a symlink, hashed before the session and compared with the pin', (t) => {
  const swift = flat(readText(SWIFT))
  const swiftPin = swift.slice(swift.indexOf('static func checkPin('), swift.indexOf('static func poolAndNormalize('))
  const regular = swiftPin.indexOf('attributes[.type] as? FileAttributeType == .typeRegular')
  t.ok(regular > 0)
  t.ok(regular < swiftPin.indexOf('hasher.update(data: data)'), 'the type check comes before the first hash')
  t.ok(swiftPin.includes('guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path), attributes[.type] as? FileAttributeType == .typeRegular, let handle = try? FileHandle(forReadingFrom: url) else { throw SentinelSpikeError.missing }'))
  t.ok(swiftPin.includes('guard total > 0, hex == expected else { throw SentinelSpikeError.pin }'))
  t.ok(swift.includes('} catch SentinelSpikeError.pin { code = "PIN" }'))
  t.is(count(swift, 'SentinelSpikeModule.checkPin('), 1)

  const kotlin = flat(readText(KOTLIN))
  const kotlinPin = kotlin.slice(kotlin.indexOf('private fun checkPin('), kotlin.indexOf('private fun open('))
  const check = kotlinPin.indexOf('if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)) throw Missing()')
  t.ok(check > 0)
  t.ok(check < kotlinPin.indexOf('FileInputStream(file)'), 'the regular-file check comes before the stream is opened')
  t.ok(check < kotlinPin.indexOf('digest.update('), 'and before the first hash')
  t.ok(kotlinPin.includes('if (total <= 0 || hex != expected) throw PinMismatch()'))
  t.ok(kotlin.includes('} catch (e: PinMismatch) { return@submit Answer.Reject("PIN") }'))
  t.is(count(kotlin, 'checkPin(file, expected)'), 1)
})

test('native error codes: a vanished model file is MISSING, no app storage is UNSUPPORTED', (t) => {
  const swift = flat(readText(SWIFT))
  const swiftLoad = swift.slice(swift.indexOf('AsyncFunction("load")'), swift.indexOf('AsyncFunction("embed")'))
  const swiftStorage = 'guard let url = SentinelSpikeModule.modelURL(kind) else { promise.reject("UNSUPPORTED", "unsupported") return }'
  t.is(count(swiftLoad, swiftStorage), 1, 'no Documents directory is UNSUPPORTED')
  t.ok(swiftLoad.indexOf(swiftStorage) < swiftLoad.indexOf('guard self.begin()'), 'checked before the busy gate, as on Android')
  // MISSING comes only from checkPin: a path that is absent, not a regular
  // file, or gone before FileHandle opens it.
  const swiftPin = swift.slice(swift.indexOf('static func checkPin('), swift.indexOf('static func poolAndNormalize('))
  t.is(count(swift, 'throw SentinelSpikeError.missing'), 1)
  t.is(count(swiftPin, 'throw SentinelSpikeError.missing'), 1)
  t.ok(swiftPin.includes('let handle = try? FileHandle(forReadingFrom: url) else { throw SentinelSpikeError.missing }'))
  t.ok(swiftLoad.includes('} catch SentinelSpikeError.missing { code = "MISSING" }'))

  const kotlin = flat(readText(KOTLIN))
  const kotlinLoad = kotlin.slice(kotlin.indexOf('AsyncFunction("load")'), kotlin.indexOf('AsyncFunction("embed")'))
  t.ok(kotlinLoad.includes('if (filesDir == null) { promise.reject("UNSUPPORTED", "unsupported", null) return@AsyncFunction }'), 'no filesDir is UNSUPPORTED')
  t.absent(kotlinLoad.includes('if (filesDir == null) { promise.reject("MISSING"'))
  const kotlinPin = kotlin.slice(kotlin.indexOf('private fun checkPin('), kotlin.indexOf('private fun open('))
  t.ok(kotlin.includes('import java.io.FileNotFoundException'))
  t.ok(kotlinPin.includes('val stream = try { FileInputStream(file) } catch (e: FileNotFoundException) { throw Missing() }'), 'a file gone before it is opened is Missing')
  t.ok(kotlinPin.includes('stream.use { input ->'))
  t.is(count(kotlinPin, 'throw Missing()'), 2)
  t.ok(kotlinLoad.includes('} catch (e: Missing) { return@submit Answer.Reject("MISSING") }'))
})

test('native sources log nothing', (t) => {
  const loggers = [/\bprint\s*\(/, /\bdebugPrint\s*\(/, /\bNSLog\b/, /\bos_log\b/, /\bLogger\s*\(/, /\bLog\.[a-z]+\s*\(/, /\bprintln\s*\(/, /\bTimber\b/, /System\.(out|err)\b/, /printStackTrace/]
  for (const file of [SWIFT, KOTLIN, INDEX]) {
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
