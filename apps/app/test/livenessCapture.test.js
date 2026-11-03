'use strict'

// src/livenessCapture.web.js and src/livenessDetector.web.js with the liveness
// package, the UI kit and react-native replaced by stubs (a module hook), so
// neither tensorflow nor react-native is loaded. The detector stub keeps the
// props it was rendered with on globalThis for the tests to drive. The
// package CSS has no stub: the detector links it at run time instead.
// src/livenessCapture.native.js gets its own stubs (the native module, the
// credentials client, expo/fetch, the UI kit and a hooks-only React driven by
// a small harness here), all reading their behaviour from globalThis.__nat.
const { register } = require('node:module')
const v8 = require('node:v8')
const vm = require('node:vm')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Writable } = require('node:stream')
const test = require('brittle')
const { createElement: h } = require('react')
const { renderToString, renderToPipeableStream } = require('react-dom/server')

const liveness = `
const box = globalThis.__liv = globalThis.__liv || { props: [] }
export function FaceLivenessDetectorCore (props) { box.props.push(props); return null }
`
const ui = `
const box = globalThis.__liv = globalThis.__liv || { props: [] }
export function Spinner (props) { box.spinner = (box.spinner || 0) + 1; return null }
`
const empty = 'export default {}'
const nat = 'const nat = () => globalThis.__nat\n'
const natStubs = {
  react: nat + `
export const createElement = (type, props) => ({ type, props: props || {} })
export const useState = (v) => nat().react.useState(v)
export const useRef = (v) => nat().react.useRef(v)
export const useEffect = (fn, deps) => nat().react.useEffect(fn, deps)
`,
  '../modules/face-liveness': nat + `
export function isAvailable () { return nat().available() }
export function start (input) { return nat().start(input) }
export function cancel (...args) { return nat().cancel(...args) }
`,
  './livenessCredentials.js': nat + 'export function createCredentialProvider (opts) { return nat().provider(opts) }\n',
  'expo/fetch': nat + 'export function fetch (url, init) { return nat().expoFetch(url, init) }\n',
  './ui': `
export function Spinner () { return null }
export function Btn () { return null }
`
}
const hooks = `
const url = (src) => 'data:text/javascript,' + encodeURIComponent(src)
const stubs = {
  '@aws-amplify/ui-react-liveness': url(${JSON.stringify(liveness)}),
  'react-native': url(${JSON.stringify(empty)})
}
const natStubs = ${JSON.stringify(natStubs)}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  if (/livenessCapture\\.native\\.js$/.test(context.parentURL || '') && natStubs[specifier]) {
    return { url: url(natStubs[specifier]), shortCircuit: true }
  }
  if (specifier === './ui' && /liveness(?:Capture|Detector)\\.web\\.js$/.test(context.parentURL || '')) {
    return { url: url(${JSON.stringify(ui)}), shortCircuit: true }
  }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks))

// Tests never reach a public network: a call that skips the injected fake
// fails here instead of going out.
globalThis.fetch = async () => { throw new Error('network disabled in tests') }

const SRC = path.join(__dirname, '../src')
const loadCapture = () => import('../src/livenessCapture.web.js')
const loadDetector = () => import('../src/livenessDetector.web.js')
const loadNative = () => import('../src/livenessCapture.native.js')
const REGION = 'us-east-1'
const POOL = 'us-east-1:12345678-1234-1234-1234-123456789abc'
const SESSION = 'sess-1'
const CODES = ['CAMERA_DENIED', 'SESSION_EXPIRED', 'UNSUPPORTED', 'FAILED']

function reset () {
  globalThis.__liv = globalThis.__liv || {}
  globalThis.__liv.props = []
  globalThis.__liv.spinner = 0
}
const box = () => globalThis.__liv

// Waits for every Suspense boundary, so the lazy detector is rendered.
function renderAll (element) {
  return new Promise((resolve, reject) => {
    let html = ''
    const sink = new Writable({
      write (chunk, enc, cb) { html += chunk; cb() },
      final (cb) { resolve(html); cb() }
    })
    const stream = renderToPipeableStream(element, {
      onAllReady () { stream.pipe(sink) },
      onShellError: reject,
      onError: reject
    })
  })
}

function withGlobals (values, fn) {
  const saved = {}
  for (const k of Object.keys(values)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k)
    Object.defineProperty(globalThis, k, { value: values[k], configurable: true, writable: true })
  }
  try {
    return fn()
  } finally {
    for (const k of Object.keys(values)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k])
      else delete globalThis[k]
    }
  }
}

// A minimal document: a head that holds fake link elements whose load and
// error events the tests fire by hand.
function fakeDocument () {
  const children = []
  const head = {
    children,
    appendChild (el) { children.push(el); el.parentNode = head; return el },
    removeChild (el) {
      const i = children.indexOf(el)
      if (i === -1) throw new Error('not a child')
      children.splice(i, 1)
      el.parentNode = null
      return el
    },
    querySelector (sel) {
      if (sel !== 'link[data-varanda-liveness]') throw new Error('unexpected selector ' + sel)
      return children.find((el) => el.attrs && 'data-varanda-liveness' in el.attrs) || null
    }
  }
  const createElement = (tag) => {
    const handlers = {}
    return {
      tagName: tag.toUpperCase(),
      attrs: {},
      parentNode: null,
      setAttribute (k, v) { this.attrs[k] = String(v) },
      addEventListener (type, fn) { (handlers[type] = handlers[type] || []).push(fn) },
      fire (type) { for (const fn of handlers[type] || []) fn({ type }) }
    }
  }
  return { head, createElement }
}

function withDocument (fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const document = fakeDocument()
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true })
  const restore = () => {
    if (saved) Object.defineProperty(globalThis, 'document', saved)
    else delete globalThis.document
  }
  let ret
  try {
    ret = fn(document)
  } catch (err) {
    restore()
    throw err
  }
  return Promise.resolve(ret).finally(restore)
}

// Runs fn while one holder keeps the stylesheet loaded, as a mounted detector
// would, so a server render shows the detector itself.
async function withLoadedSheet (fn) {
  const { acquireStylesheet } = await loadDetector()
  return withDocument(async (document) => {
    const release = acquireStylesheet(() => {})
    document.head.children[0].fire('load')
    try {
      return await fn(document)
    } finally {
      release()
    }
  })
}

function cognitoFetch () {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    const target = init.headers['X-Amz-Target']
    const body = target.endsWith('.GetId')
      ? { IdentityId: 'us-east-1:id' }
      : { Credentials: { AccessKeyId: 'AK', SecretKey: 'SK', SessionToken: 'ST', Expiration: 2000000000 } }
    return { status: 200, redirected: false, json: async () => body }
  }
  return { fetch, calls }
}

test('detector: props reach FaceLivenessDetectorCore with the start screen kept', async (t) => {
  reset()
  const { LivenessDetector, DISPLAY_TEXT } = await loadDetector()
  const credentialProvider = async () => ({})
  await withLoadedSheet(() => renderToString(h(LivenessDetector, {
    sessionId: SESSION, region: REGION, credentialProvider, onComplete () {}, onError () {}, onCancel () {}
  })))
  t.is(box().props.length, 1, 'rendered once')
  const p = box().props[0]
  t.is(p.sessionId, SESSION)
  t.is(p.region, REGION)
  t.alike(Object.keys(p.config), ['credentialProvider'], 'config holds only the provider')
  t.is(p.config.credentialProvider, credentialProvider, 'the caller provider')
  t.absent('disableStartScreen' in p, 'disableStartScreen is not set')
  t.is(p.displayText, DISPLAY_TEXT, 'pt-BR display text')
  t.is(typeof p.onAnalysisComplete, 'function')
  t.is(typeof p.onUserCancel, 'function')
})

test('detector: display text keys are the package keys, in pt-BR', async (t) => {
  const { DISPLAY_TEXT } = await loadDetector()
  const css = require.resolve('@aws-amplify/ui-react-liveness/dist/styles.css')
  const file = path.join(path.dirname(css), 'esm/components/FaceLivenessDetector/displayText.mjs')
  const known = new Set([...fs.readFileSync(file, 'utf8').matchAll(/^\s+(\w+Text):/gm)].map((m) => m[1]))
  t.ok(known.size > 40, 'package keys found')
  const unknown = Object.keys(DISPLAY_TEXT).filter((k) => !known.has(k))
  t.alike(unknown, [], 'no invented key')
  const missing = [...known].filter((k) => !/^photosensitivy/.test(k) && !(k in DISPLAY_TEXT))
  t.alike(missing, [], 'every current key translated')
  t.is(DISPLAY_TEXT.startScreenBeginCheckText, 'Começar a verificação')
  t.absent(Object.values(DISPLAY_TEXT).some((v) => v.includes(String.fromCharCode(0x2014))), 'no em dash')
})

test('detector: analysis complete fires onComplete, cancel fires onCancel', async (t) => {
  reset()
  const { LivenessDetector } = await loadDetector()
  const seen = { complete: [], cancel: 0 }
  await withLoadedSheet(() => renderToString(h(LivenessDetector, {
    sessionId: SESSION,
    region: REGION,
    credentialProvider: async () => ({}),
    onComplete (...args) { seen.complete.push(args) },
    onError () { t.fail('no error') },
    onCancel () { seen.cancel++ }
  })))
  const p = box().props[0]
  const ret = p.onAnalysisComplete({ deviceId: 'd', groupId: 'g', label: 'cam' })
  t.ok(ret && typeof ret.then === 'function', 'returns a promise')
  await ret
  t.alike(seen.complete, [[]], 'onComplete called once with no arguments')
  p.onUserCancel()
  t.is(seen.cancel, 1)
})

test('detector: errors map to codes only', async (t) => {
  reset()
  const { LivenessDetector, errorCode } = await loadDetector()
  const seen = []
  await withLoadedSheet(() => renderToString(h(LivenessDetector, {
    sessionId: SESSION,
    region: REGION,
    credentialProvider: async () => ({}),
    onComplete () {},
    onError (...args) { seen.push(args) },
    onCancel () {}
  })))
  const p = box().props[0]
  const secret = 'AccessDenied for arn:aws:sts::123:assumed-role/x sess-1'
  const fail = (state, name) => {
    const error = new Error(secret)
    if (name) error.name = name
    return { state, error }
  }
  const cases = [
    [fail('CAMERA_ACCESS_ERROR'), 'CAMERA_DENIED'],
    [fail('DEFAULT_CAMERA_NOT_FOUND_ERROR'), 'CAMERA_DENIED'],
    [fail('CAMERA_FRAMERATE_ERROR'), 'UNSUPPORTED'],
    [fail('SERVER_ERROR', 'ValidationException'), 'SESSION_EXPIRED'],
    [fail('SERVER_ERROR', 'SessionNotFoundException'), 'SESSION_EXPIRED'],
    [fail('SERVER_ERROR', 'ThrottlingException'), 'FAILED'],
    [fail('SERVER_ERROR'), 'FAILED'],
    [fail('CONNECTION_TIMEOUT'), 'FAILED'],
    [fail('TIMEOUT'), 'FAILED'],
    [fail('RUNTIME_ERROR'), 'FAILED'],
    [fail('MULTIPLE_FACES_ERROR'), 'FAILED'],
    [undefined, 'FAILED'],
    [{ state: 'SERVER_ERROR', error: null }, 'FAILED']
  ]
  for (const [err, code] of cases) {
    t.is(errorCode(err), code, (err && err.state) + ' -> ' + code)
    p.onError(err, { deviceId: 'd', groupId: 'g', label: 'cam' })
  }
  t.is(seen.length, cases.length, 'one onError per detector error')
  t.ok(seen.every((args) => args.length === 1 && CODES.includes(args[0])), 'only a code is passed')
  t.absent(JSON.stringify(seen).includes('AccessDenied'), 'no AWS message')
})

test('capture: isAvailable needs a secure context and getUserMedia', async (t) => {
  const { isAvailable } = await loadCapture()
  const media = { mediaDevices: { getUserMedia () {} } }
  t.ok(withGlobals({ isSecureContext: true, navigator: media }, isAvailable), 'secure with camera API')
  t.absent(withGlobals({ isSecureContext: false, navigator: media }, isAvailable), 'insecure context')
  t.absent(withGlobals({ isSecureContext: undefined, navigator: media }, isAvailable), 'no isSecureContext')
  t.absent(withGlobals({ isSecureContext: true, navigator: {} }, isAvailable), 'no mediaDevices')
  t.absent(withGlobals({ isSecureContext: true, navigator: { mediaDevices: {} } }, isAvailable), 'no getUserMedia')
  t.absent(withGlobals({ isSecureContext: true, navigator: undefined }, isAvailable), 'no navigator')
})

test('capture: the credential provider reaches the detector and uses the page fetch', async (t) => {
  reset()
  const { LivenessCapture } = await loadCapture()
  const seen = { complete: [], errors: [], cancel: 0 }
  const html = await withLoadedSheet(() => renderAll(h(LivenessCapture, {
    sessionId: SESSION,
    region: REGION,
    identityPoolId: POOL,
    onComplete (...args) { seen.complete.push(args) },
    onError (...args) { seen.errors.push(args) },
    onCancel () { seen.cancel++ }
  })))
  t.is(typeof html, 'string')
  t.is(box().props.length, 1, 'the lazy detector rendered')
  const p = box().props[0]
  t.is(p.sessionId, SESSION)
  t.is(p.region, REGION)
  t.absent('identityPoolId' in p, 'pool id stays in the capture')
  t.absent('disableStartScreen' in p, 'start screen kept')
  t.is(typeof p.config.credentialProvider, 'function')

  const fake = cognitoFetch()
  const before = globalThis.fetch
  globalThis.fetch = fake.fetch
  let creds
  try {
    creds = await p.config.credentialProvider()
  } finally {
    globalThis.fetch = before
  }
  t.is(fake.calls.length, 2, 'GetId then GetCredentialsForIdentity through globalThis.fetch')
  t.is(fake.calls[0].url, 'https://cognito-identity.us-east-1.amazonaws.com/')
  t.is(JSON.parse(fake.calls[0].init.body).IdentityPoolId, POOL)
  t.is(creds.accessKeyId, 'AK')

  await p.onAnalysisComplete()
  t.alike(seen.complete, [[]], 'onComplete with no arguments')
  p.onError({ state: 'CAMERA_ACCESS_ERROR', error: new Error('raw') })
  t.alike(seen.errors, [['CAMERA_DENIED']], 'onError with the code only')
  p.onUserCancel()
  t.is(seen.cancel, 1)
})

test('capture: Spinner is the fallback while the detector loads', async (t) => {
  const src = fs.readFileSync(path.join(SRC, 'livenessCapture.web.js'), 'utf8')
  t.ok(/import \{[^}]*\bSpinner\b[^}]*\} from '\.\/ui'/.test(src), 'Spinner from the ui kit')
  t.ok(/lazy\(\(\) => import\('\.\/livenessDetector\.web\.js'\)\)/.test(src), 'dynamic import of the detector')
  t.ok(/fallback: h\(Spinner/.test(src), 'Spinner fallback')
  t.ok(src.includes('fetch: (u, i) => globalThis.fetch(u, i)'), 'fetch looked up at call time')
})

// A hooks-only stand-in for React that runs effects right after a render, as
// a committed mount would, and can replay the StrictMode double effect run.
function mount (Component, props, { strict = false } = {}) {
  const slots = []
  let effects = []
  let i = 0
  let rendering = false
  let dirty = false
  let mounted = true
  const out = { tree: null, renders: 0, lateSets: 0 }
  globalThis.__nat.react = {
    useState (init) {
      const s = slots[i] || (slots[i] = { v: init })
      i++
      return [s.v, (v) => {
        if (!mounted) { out.lateSets++; return }
        s.v = typeof v === 'function' ? v(s.v) : v
        if (rendering) dirty = true
        else render()
      }]
    },
    useRef (init) {
      const s = slots[i] || (slots[i] = { current: init })
      i++
      return s
    },
    useEffect (fn, deps) {
      const s = slots[i] || (slots[i] = { deps: null, cleanup: null })
      i++
      if (s.deps && deps && deps.length === s.deps.length && deps.every((d, k) => d === s.deps[k])) return
      effects.push(() => {
        if (s.cleanup) s.cleanup()
        s.cleanup = fn() || null
        s.deps = deps
      })
    }
  }
  function render () {
    rendering = true
    do {
      dirty = false
      i = 0
      out.tree = Component(props)
      out.renders++
      const run = effects
      effects = []
      for (const e of run) e()
      if (strict && out.renders === 1) {
        for (const s of slots) if (s && s.cleanup) { s.cleanup(); s.cleanup = null }
        for (const e of run) e()
      }
    } while (dirty)
    rendering = false
  }
  render()
  out.unmount = () => {
    mounted = false
    for (const s of slots) if (s && s.cleanup) { s.cleanup(); s.cleanup = null }
  }
  out.kind = () => out.tree && out.tree.type && out.tree.type.name
  return out
}

const flush = async () => { for (let k = 0; k < 5; k++) await new Promise(setImmediate) }
// Lets the unmount check, which waits on a timer, run.
const settleTimers = async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await flush() }

function deferred () {
  const d = {}
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject })
  return d
}

const codeErr = (code) => Object.assign(new Error('x'), { code })

// Each start of the capture builds a provider and calls it once; every call
// hands out a fresh credentials object.
function natSetup ({ start, provide } = {}) {
  const seen = { factories: [], provided: [], starts: [], expoFetch: [], cancels: [] }
  globalThis.__nat = {
    available: () => true,
    cancel: (...args) => { seen.cancels.push(args) },
    expoFetch: async (url, init) => { seen.expoFetch.push({ url, init }); return { status: 200 } },
    provider (opts) {
      seen.factories.push(opts)
      return async () => {
        if (provide) return provide()
        const c = { accessKeyId: 'AK' + seen.provided.length, secretAccessKey: 'SK', sessionToken: 'ST', expiration: new Date(2e12) }
        seen.provided.push(c)
        return c
      }
    },
    start: (input) => {
      seen.starts.push(input)
      return start ? start(input) : Promise.resolve({ ok: true })
    }
  }
  return seen
}

function callbacks () {
  const calls = []
  return {
    calls,
    props: {
      sessionId: SESSION,
      region: REGION,
      identityPoolId: POOL,
      onComplete: (...a) => calls.push(['complete', ...a]),
      onError: (...a) => calls.push(['error', ...a]),
      onCancel: (...a) => calls.push(['cancel', ...a])
    }
  }
}

test('native: isAvailable is the module answer', async (t) => {
  natSetup()
  const { isAvailable } = await loadNative()
  t.is(isAvailable(), true, 'available when the module says so')
  globalThis.__nat.available = () => false
  t.is(isAvailable(), false)
  globalThis.__nat.available = () => { throw new Error('boom') }
  t.is(isAvailable(), false, 'a throwing module is unavailable')
  globalThis.__nat.available = () => 'yes'
  t.is(isAvailable(), false, 'only a true answer counts')
})

test('native: one provider call per start, its credentials passed once to the module', async (t) => {
  const seen = natSetup()
  const { LivenessCapture } = await loadNative()
  const cb = callbacks()
  const m = mount(LivenessCapture, cb.props)
  t.is(m.kind(), 'Spinner', 'spinner while credentials load')
  await flush()
  t.is(seen.factories.length, 1, 'one provider')
  t.is(seen.factories[0].region, REGION)
  t.is(seen.factories[0].identityPoolId, POOL)
  t.is(seen.provided.length, 1, 'credentials fetched once')
  t.is(seen.starts.length, 1, 'module started once')
  t.alike(Object.keys(seen.starts[0]).sort(), ['credentials', 'region', 'sessionId'])
  t.is(seen.starts[0].sessionId, SESSION)
  t.is(seen.starts[0].region, REGION)
  t.is(seen.starts[0].credentials, seen.provided[0], 'the provider answer, untouched')
  t.alike(cb.calls, [['complete']], 'onComplete with no arguments')
  await seen.factories[0].fetch('https://cognito.test/', { method: 'POST' })
  t.is(seen.expoFetch.length, 1, 'the provider fetch is expo/fetch')
  m.unmount()
})

test('native: credentials are not retained once the module has them', async (t) => {
  v8.setFlagsFromString('--expose-gc')
  const gc = vm.runInNewContext('gc')
  let weak = null
  natSetup({
    provide: () => {
      const c = { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST', expiration: new Date(2e12) }
      weak = new WeakRef(c)
      return c
    },
    start: () => Promise.resolve({ ok: true })
  })
  globalThis.__nat.start = () => Promise.resolve({ ok: true })
  const mod = await loadNative()
  t.alike(Object.keys(mod).sort(), ['LivenessCapture', 'isAvailable'], 'no exported state')
  const cb = callbacks()
  const m = mount(mod.LivenessCapture, cb.props)
  await flush()
  t.alike(cb.calls, [['complete']])
  t.ok(weak, 'credentials were handed out')
  // A deref() keeps its target alive until the job ends, so gc runs in jobs
  // that never deref.
  for (let k = 0; k < 5; k++) { await flush(); gc() }
  await flush()
  t.is(weak.deref(), undefined, 'collectable while the capture is still mounted')
  m.unmount()
})

test('native: module codes map to the web codes', async (t) => {
  const { LivenessCapture } = await loadNative()
  const cases = [
    ['CANCELLED', ['cancel']],
    ['CAMERA_DENIED', ['error', 'CAMERA_DENIED']],
    ['SESSION_EXPIRED', ['error', 'SESSION_EXPIRED']],
    ['UNSUPPORTED', ['error', 'UNSUPPORTED']],
    ['INVALID', ['error', 'FAILED']],
    ['BUSY', ['error', 'FAILED']],
    ['FAILED', ['error', 'FAILED']],
    ['SOMETHING_ELSE', ['error', 'FAILED']],
    [undefined, ['error', 'FAILED']]
  ]
  for (const [code, want] of cases) {
    natSetup({ start: () => Promise.reject(codeErr(code)) })
    const cb = callbacks()
    const m = mount(LivenessCapture, cb.props)
    await flush()
    t.alike(cb.calls, [want], String(code))
    m.unmount()
  }
  for (const v of [null, 'text']) {
    natSetup({ start: () => Promise.reject(v) })
    const cb = callbacks()
    const m = mount(LivenessCapture, cb.props)
    await flush()
    t.alike(cb.calls, [['error', 'FAILED']], 'rejected with ' + v)
    m.unmount()
  }
})

test('native: a credentials failure is FAILED and never starts the module', async (t) => {
  const { LivenessCapture } = await loadNative()
  for (const code of ['CREDENTIALS', 'TIMEOUT', 'CANCELLED', 'CAMERA_DENIED']) {
    const seen = natSetup({ provide: () => Promise.reject(codeErr(code)) })
    const cb = callbacks()
    const m = mount(LivenessCapture, cb.props)
    await flush()
    t.is(seen.starts.length, 0, code + ': no start')
    t.alike(cb.calls, [['error', 'FAILED']], code)
    t.is(m.kind(), 'Spinner', code + ': no retry button of its own')
    m.unmount()
  }
})

test('native: a double effect run starts once and still delivers', async (t) => {
  const seen = natSetup()
  const { LivenessCapture } = await loadNative()
  const cb = callbacks()
  const m = mount(LivenessCapture, cb.props, { strict: true })
  await flush()
  t.is(seen.provided.length, 1, 'credentials once')
  t.is(seen.starts.length, 1, 'start once')
  t.alike(cb.calls, [['complete']])
  m.unmount()
})

test('native: after CAMERA_DENIED a tap on Tentar de novo starts again with fresh credentials', async (t) => {
  const answers = [deferred(), deferred(), deferred()]
  let n = 0
  const seen = natSetup({ start: () => answers[n++].promise })
  const { LivenessCapture } = await loadNative()
  const cb = callbacks()
  const m = mount(LivenessCapture, cb.props)
  await flush()
  t.is(m.kind(), 'Spinner', 'spinner while the native screen is up')
  answers[0].reject(codeErr('CAMERA_DENIED'))
  await flush()
  t.alike(cb.calls, [['error', 'CAMERA_DENIED']])
  t.is(m.kind(), 'Btn', 'retry button')
  t.is(m.tree.props.label, 'Tentar de novo')
  await flush()
  t.is(seen.starts.length, 1, 'never retried on its own')
  const press = m.tree.props.onPress
  press()
  press()
  t.is(m.kind(), 'Spinner', 'spinner again')
  await flush()
  t.is(seen.provided.length, 2, 'fresh credentials, one fetch for two taps')
  t.is(seen.factories.length, 2, 'a new provider')
  t.is(seen.starts.length, 2, 'one new start')
  t.not(seen.starts[1].credentials, seen.starts[0].credentials, 'not the first credentials')
  t.is(seen.starts[1].credentials, seen.provided[1])
  answers[1].resolve({ ok: true })
  await flush()
  t.alike(cb.calls, [['error', 'CAMERA_DENIED'], ['complete']])
  m.unmount()
})

test('native: a result after unmount calls nothing', async (t) => {
  const { LivenessCapture } = await loadNative()
  for (const settle of [(d) => d.resolve({ ok: true }), (d) => d.reject(codeErr('CAMERA_DENIED')), (d) => d.reject(codeErr('CANCELLED'))]) {
    const d = deferred()
    natSetup({ start: () => d.promise })
    const cb = callbacks()
    const m = mount(LivenessCapture, cb.props)
    await flush()
    m.unmount()
    settle(d)
    await flush()
    t.alike(cb.calls, [], 'no callback')
    t.is(m.lateSets, 0, 'no state update')
  }
  const slow = deferred()
  const seen = natSetup({ provide: () => slow.promise })
  const cb = callbacks()
  const m = mount(LivenessCapture, cb.props)
  m.unmount()
  slow.resolve({ accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST', expiration: new Date(2e12) })
  await flush()
  t.alike(cb.calls, [], 'credentials after unmount: no callback')
  t.is(seen.starts.length, 0, 'the native screen never opens after the capture left')
})

test('native: a real unmount during start closes the native screen once', async (t) => {
  await settleTimers() // an earlier test's unmount check must not land here
  const d = deferred()
  const seen = natSetup({ start: () => d.promise })
  const { LivenessCapture } = await loadNative()
  const cb = callbacks()
  const m = mount(LivenessCapture, cb.props)
  await flush()
  t.is(seen.starts.length, 1, 'the native screen is up')
  t.is(seen.cancels.length, 0, 'nothing closed while mounted')
  m.unmount()
  await settleTimers()
  t.alike(seen.cancels, [[]], 'cancel once, no arguments')
  d.reject(codeErr('CANCELLED'))
  await settleTimers()
  t.alike(cb.calls, [], 'the CANCELLED that follows calls no callback')
  t.is(m.lateSets, 0, 'no state update')
  t.is(seen.cancels.length, 1, 'still once')
  t.is(seen.starts.length, 1, 'never reopened')
})

test('native: a StrictMode replay never closes the native screen', async (t) => {
  await settleTimers()
  const d = deferred()
  const seen = natSetup({ start: () => d.promise })
  const { LivenessCapture } = await loadNative()
  const cb = callbacks()
  const m = mount(LivenessCapture, cb.props, { strict: true })
  await settleTimers()
  t.is(seen.starts.length, 1, 'started once')
  t.is(seen.cancels.length, 0, 'the replay cleanup does not cancel')
  d.resolve({ ok: true })
  await settleTimers()
  t.alike(cb.calls, [['complete']], 'the result still arrives')
  m.unmount()
  await settleTimers()
  t.is(seen.cancels.length, 0, 'nothing running at unmount')
})

test('native: an unmount with nothing running never cancels', async (t) => {
  await settleTimers()
  const { LivenessCapture } = await loadNative()
  for (const answer of [() => Promise.resolve({ ok: true }), () => Promise.reject(codeErr('CAMERA_DENIED')), () => Promise.reject(codeErr('CANCELLED'))]) {
    const seen = natSetup({ start: answer })
    const cb = callbacks()
    const m = mount(LivenessCapture, cb.props)
    await settleTimers()
    t.is(cb.calls.length, 1, 'the attempt finished')
    m.unmount()
    await settleTimers()
    t.is(seen.cancels.length, 0, 'no cancel after ' + cb.calls[0][0])
  }
})

test('native: source keeps credentials in the call frame, no amplify, no CSS', async (t) => {
  const src = fs.readFileSync(path.join(SRC, 'livenessCapture.native.js'), 'utf8')
  t.absent(/@aws-amplify|aws-amplify/.test(src), 'no amplify')
  t.absent(/(?:from|import\s*\(?|require\s*\()\s*['"][^'"]+\.css['"]/.test(src), 'no CSS')
  t.absent(/^(?:let|var)\s/m.test(src), 'no module-level variable')
  t.absent(/use(?:Ref|State)\([^)]*credentials/.test(src), 'no ref or state for credentials')
  t.absent(/\.current\s*=\s*credentials|setState|console\./.test(src), 'credentials never stored or logged')
  t.ok(/from '\.\.\/modules\/face-liveness'/.test(src), 'the native module')
  t.ok(/from 'expo\/fetch'/.test(src), 'expo/fetch')
})

function sources (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(file))
    else if (entry.name.endsWith('.js')) out.push(file)
  }
  return out
}

test('source: only livenessDetector.web.js imports @aws-amplify; no global Amplify setup', async (t) => {
  const files = sources(SRC).concat(path.join(__dirname, '../App.js'))
  t.ok(files.length > 10, 'app sources scanned')
  const detector = path.join(SRC, 'livenessDetector.web.js')
  const importers = []
  const configure = []
  const fetchAssign = []
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    const rel = path.relative(path.join(SRC, '..'), file)
    if (/(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]@aws-amplify\//.test(src) || /['"]aws-amplify(?:\/[^'"]*)?['"]/.test(src)) {
      if (file !== detector) importers.push(rel)
    }
    if (/Amplify\s*\.\s*configure/.test(src)) configure.push(rel)
    if (/(?:\bwindow|\bglobalThis|\bself|\bglobal)\s*\.\s*fetch\s*=(?!=)/.test(src) || /\[\s*['"]fetch['"]\s*\]\s*=(?!=)/.test(src)) fetchAssign.push(rel)
  }
  t.alike(importers, [], 'no other @aws-amplify importer')
  t.alike(configure, [], 'no Amplify.configure')
  t.alike(fetchAssign, [], 'no fetch assignment')
})

test('source: no @aws-amplify stylesheet is imported anywhere in src', async (t) => {
  const files = sources(SRC).concat(path.join(__dirname, '../App.js'))
  const offenders = []
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    if (/['"]@aws-amplify\/[^'"]*\.css['"]/.test(src) || src.includes('@aws-amplify/ui-react-liveness/styles.css')) {
      offenders.push(path.relative(path.join(SRC, '..'), file))
    }
  }
  t.alike(offenders, [], 'Metro web would hoist it into the global stylesheet')
})

test('detector: the module imports no CSS and mounts the stylesheet from an effect', async (t) => {
  const src = fs.readFileSync(path.join(SRC, 'livenessDetector.web.js'), 'utf8')
  t.absent(/import\s+['"][^'"]+\.css['"]/.test(src), 'no side-effect CSS import')
  t.absent(/(?:from|import\s*\(|require\s*\()\s*['"][^'"]+\.css['"]/.test(src), 'no CSS import of any kind')
  t.ok(/useEffect\(\(\) => watchStylesheet\(/.test(src), 'linked while mounted')
  const { LIVENESS_STYLESHEET } = await loadDetector()
  t.is(LIVENESS_STYLESHEET, '/liveness/amplify-ui.css')
})

test('detector: one shared link, removed after the last release', async (t) => {
  const { acquireStylesheet, LIVENESS_STYLESHEET } = await loadDetector()
  await withDocument((document) => {
    const head = document.head
    const release1 = acquireStylesheet(() => {})
    t.is(head.children.length, 1, 'mount adds one link')
    const link = head.children[0]
    t.is(link.tagName, 'LINK')
    t.is(link.rel, 'stylesheet')
    t.is(link.href, LIVENESS_STYLESHEET)
    t.ok('data-varanda-liveness' in link.attrs, 'marked as ours')
    const release2 = acquireStylesheet(() => {})
    t.is(head.children.length, 1, 'a second mount shares it')
    release1()
    t.is(head.children.length, 1, 'kept while one mount remains')
    release1()
    t.is(head.children.length, 1, 'a repeated release does not count twice')
    release2()
    t.is(head.children.length, 0, 'the last unmount removes it')
    const release3 = acquireStylesheet(() => {})
    t.is(head.children.length, 1, 'a later mount links it again')
    t.not(head.children[0], link, 'with a fresh link')
    release3()
    t.is(head.children.length, 0)
  })
})

test('detector: renders only after the stylesheet load event', async (t) => {
  reset()
  const { LivenessDetector, watchStylesheet } = await loadDetector()
  const props = { sessionId: SESSION, region: REGION, credentialProvider: async () => ({}), onComplete () {}, onError () { t.fail('no error') }, onCancel () {} }
  t.is(renderToString(h(LivenessDetector, props)), '', 'only the stubbed Spinner without a stylesheet')
  t.is(box().props.length, 0)
  t.is(box().spinner, 1, 'Spinner without a stylesheet')
  await withDocument((document) => {
    const ready = []
    const release = watchStylesheet((r) => ready.push(r), () => t.fail('no error'))
    t.alike(ready, [false], 'not ready while loading')
    renderToString(h(LivenessDetector, props))
    t.is(box().props.length, 0, 'not rendered before load')
    t.is(box().spinner, 2, 'Spinner while the stylesheet loads')
    document.head.children[0].fire('load')
    t.alike(ready, [false, true], 'ready on load')
    renderToString(h(LivenessDetector, props))
    t.is(box().props.length, 1, 'rendered after load')
    t.is(box().spinner, 2, 'no Spinner once loaded')
    const second = []
    const release2 = watchStylesheet((r) => second.push(r), () => t.fail('no error'))
    t.alike(second, [true], 'a later mount is ready at once')
    release2()
    release()
    renderToString(h(LivenessDetector, props))
    t.is(box().props.length, 1, 'not rendered once released')
  })
})

test('detector: a stylesheet error maps to onError(FAILED)', async (t) => {
  const { watchStylesheet } = await loadDetector()
  await withDocument((document) => {
    const ready = []
    const errors = []
    const release = watchStylesheet((r) => ready.push(r), (...args) => errors.push(args))
    document.head.children[0].fire('error')
    t.alike(errors, [['FAILED']], 'one onError with FAILED')
    t.alike(ready, [false, false], 'never ready')
    release()
    t.is(document.head.children.length, 0, 'link removed, so a retry loads it again')
  })
})

const APP = path.join(__dirname, '..')
const { copyLivenessCss, livenessSource, LIVENESS_TARGET } = require('../scripts/copy-liveness-css')
const { finishWeb } = require('../scripts/finish-web')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-liveness-'))
let tmpCount = 0
const tmpDir = () => fs.mkdtempSync(path.join(TMP, 'd' + tmpCount++ + '-'))
const quiet = (fn) => {
  const log = console.log
  console.log = () => {}
  try { return fn() } finally { console.log = log }
}

test('copy-liveness-css: byte-identical copy, idempotent', (t) => {
  const source = livenessSource()
  t.ok(source && fs.existsSync(source), 'package stylesheet resolved')
  const dir = tmpDir()
  const target = copyLivenessCss(dir)
  t.is(target, path.join(dir, LIVENESS_TARGET))
  t.is(LIVENESS_TARGET, path.join('liveness', 'amplify-ui.css'))
  const css = fs.readFileSync(source)
  t.ok(css.equals(fs.readFileSync(target)), 'byte for byte the package file')
  copyLivenessCss(dir)
  t.ok(css.equals(fs.readFileSync(target)), 'second run: identical')
  t.alike(fs.readdirSync(path.join(dir, 'liveness')), ['amplify-ui.css'], 'one file')
  t.exception(() => copyLivenessCss(tmpDir(), path.join(TMP, 'missing.css')), /estilo da verificação de rosto/)
  t.exception(() => copyLivenessCss(tmpDir(), null), /estilo da verificação de rosto/)
})

test('copy-liveness-css: the dev server script copies into public, which is ignored', (t) => {
  const scripts = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).scripts
  t.ok(/node scripts\/copy-liveness-css\.js public && expo start --web$/.test(scripts.web), 'web copies before the dev server starts')
  t.ok(scripts['export:web'].endsWith('node scripts/finish-web.js'), 'the export keeps its dist copy')
  const ignored = fs.readFileSync(path.join(APP, '.gitignore'), 'utf8').split('\n')
  t.ok(ignored.includes('/public/liveness/'), 'generated, never committed')
})

test('copy-liveness-css: an export that already holds the public copy keeps one identical file', (t) => {
  const dist = tmpDir()
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true })
    fs.writeFileSync(path.join(dist, rel), text)
  }
  write('index.html', '<!DOCTYPE html><html><head></head><body></body></html>')
  write('varanda-node.js', '1\n')
  write('manifest.webmanifest', '{}')
  write('_expo/static/js/web/index-0.js', '1\n')
  // What expo export leaves in dist once `npm run web` has filled public/liveness/.
  copyLivenessCss(dist)
  quiet(() => finishWeb(dist))
  const sw1 = fs.readFileSync(path.join(dist, 'sw.js'))
  quiet(() => finishWeb(dist))
  t.alike(fs.readdirSync(path.join(dist, 'liveness')), ['amplify-ui.css'], 'one file')
  t.ok(fs.readFileSync(livenessSource()).equals(fs.readFileSync(path.join(dist, 'liveness', 'amplify-ui.css'))), 'byte for byte')
  t.ok(sw1.equals(fs.readFileSync(path.join(dist, 'sw.js'))), 'finish-web stays idempotent')
})
