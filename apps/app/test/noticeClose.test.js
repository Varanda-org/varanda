'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

function navigatorStub (t, serviceWorker) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker } })
  t.teardown(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
    else delete globalThis.navigator
  })
}

test('closeNotices: native without its module is harmless and never touches browser globals', async (t) => {
  navigatorStub(t, new Proxy({}, { get () { throw new Error('native touched the browser') } }))
  const native = await import('../src/noticeClose.native.js')
  t.is(await native.closeNotices(['varanda-dm']), undefined)
  const off = native.subscribeSeenSync(() => t.fail('native received a signal'))
  t.is(off(), undefined)
})

async function nativeClose (device, secure) {
  const source = fs.readFileSync(path.join(__dirname, '../src/noticeClose.native.js'), 'utf8')
  const { code } = transformSync(source, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const modules = {
    '../modules/push-device/index.js': device,
    'expo-secure-store': secure,
    '@noble/hashes/blake2.js': await import('@noble/hashes/blake2.js'),
    '@noble/hashes/utils.js': await import('@noble/hashes/utils.js'),
    './noticeTags.js': await import('../src/noticeTags.js'),
    './pushDevice.js': await import('../src/pushDevice.js'),
    './passkeyOptions.js': await import('../src/passkeyOptions.js')
  }
  const exports = {}
  const load = new Function('require', 'exports', code) // eslint-disable-line no-new-func
  load((name) => {
    if (!modules[name]) throw new Error('unavailable: ' + name)
    return modules[name]
  }, exports)
  return exports
}

test('native tags match the server keyed BLAKE2b-256 derivation with sodium-universal', async (t) => {
  const sodium = require('sodium-universal')
  const { deriveNativeTag } = await import('../src/noticeClose.native.js')
  t.is(deriveNativeTag('varanda-dm', 'A'.repeat(22)), '8p34eINm_k8OUlmh')
  const keys = [Buffer.alloc(16), Buffer.from(Array.from({ length: 16 }, (_, i) => i)), Buffer.alloc(16, 255)]
  const tags = ['varanda-dm', 'varanda-dm-page', 'varanda-group-private', 'varanda-group-' + 'ab'.repeat(32), 'varanda-like-' + 'cd'.repeat(32) + ':123']
  for (const key of keys) {
    for (const tag of tags) {
      const digest = Buffer.alloc(32)
      sodium.crypto_generichash(digest, Buffer.from(tag), key)
      const native = deriveNativeTag(tag, key.toString('base64url'))
      t.is(native, digest.toString('base64url').slice(0, 16))
      t.ok(/^[A-Za-z0-9_-]{16}$/.test(native))
    }
  }
  for (const key of [null, '', 'invalid', 'A'.repeat(21) + 'B', 'A'.repeat(22) + '\n']) {
    t.is(deriveNativeTag('varanda-dm', key), null)
  }
  for (const tag of [null, 'invalid', 'varanda-dm\n']) t.is(deriveNativeTag(tag, keys[0].toString('base64url')), null)
})

test('native close filters and caps web tags before deriving with the installation key', async (t) => {
  const key = Buffer.alloc(16, 7).toString('base64url')
  const calls = []
  const reads = []
  const native = await nativeClose({
    isAvailable: () => true,
    clearDelivered: async tags => calls.push(tags)
  }, {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 17,
    getItemAsync: async (name, options) => { reads.push([name, options]); return key }
  })
  const { CLOSE_MAX } = await import('../src/noticeTags.js')
  const groups = Array.from({ length: CLOSE_MAX + 4 }, (_, i) => 'varanda-group-' + i.toString(16).padStart(64, '0'))
  await native.closeNotices([null, {}, 'invalid', 'varanda-dm\n', 'varanda-dm', 'varanda-dm', ...groups])
  t.alike(reads, [['varanda.push-device.key', { keychainAccessible: 17 }]])
  t.alike(calls, [['varanda-dm', ...groups.slice(0, CLOSE_MAX - 1)].map(tag => native.deriveNativeTag(tag, key))])
  for (const tags of [null, [], 'varanda-dm', [null, 'invalid']]) await native.closeNotices(tags)
  t.is(reads.length, 1)
  t.is(calls.length, 1)
})

test('native close with no valid key, unavailable storage or failed module is harmless', async (t) => {
  let calls = 0
  for (const key of [null, '', 'invalid', 'A'.repeat(21) + 'B']) {
    const native = await nativeClose({ isAvailable: () => true, clearDelivered: () => { calls++ } }, { getItemAsync: async () => key })
    t.is(await native.closeNotices(['varanda-dm']), undefined)
  }
  t.is(calls, 0)
  for (const secure of [null, { getItemAsync: async () => { throw new Error('locked') } }]) {
    const native = await nativeClose({ isAvailable: () => true, clearDelivered: () => { calls++ } }, secure)
    t.is(await native.closeNotices(['varanda-dm']), undefined)
  }
  t.is(calls, 0)
  const native = await nativeClose({ isAvailable: () => true, clearDelivered: async () => { calls++; throw new Error('gone') } }, { getItemAsync: async () => 'A'.repeat(22) })
  t.is(await native.closeNotices(['varanda-dm']), undefined)
  t.is(calls, 1)
})

test('native seen-sync wakes remote and unsubscribes from the module', async (t) => {
  let receive
  let removed = 0
  const native = await nativeClose({
    onSync: listener => {
      receive = listener
      return () => { receive = null; removed++ }
    }
  })
  const wakes = []
  const off = native.subscribeSeenSync(reason => wakes.push(reason))
  receive()
  t.alike(wakes, ['remote'])
  off()
  t.is(receive, null)
  t.is(removed, 1)
})

test('closeNotices: web sends only valid unique tags, at most sixteen, to the active worker', async (t) => {
  const sent = []
  navigatorStub(t, { getRegistration: async () => ({ active: { postMessage: (message) => sent.push(message) } }) })
  const { closeNotices } = await import('../src/noticeClose.web.js')
  const { validTag } = await import('../src/noticeTags.js')
  const groups = Array.from({ length: 20 }, (_, i) => 'varanda-group-' + i.toString(16).padStart(64, '0'))
  await closeNotices([null, 'invalid', 'varanda-dm\n', {}, 'varanda-dm', 'varanda-dm', ...groups])
  t.is(sent.length, 1)
  t.is(sent[0].type, 'varanda-notices-close')
  t.is(sent[0].tags.length, 16)
  t.is(new Set(sent[0].tags).size, 16)
  t.ok(sent[0].tags.every(validTag))
  t.alike(sent[0].tags, ['varanda-dm', ...groups.slice(0, 15)])
  await closeNotices([null, 'invalid'])
  await closeNotices(null)
  t.is(sent.length, 1, 'nothing to close')
})

test('closeNotices: missing registrations and failed worker posts are harmless', async (t) => {
  const { closeNotices } = await import('../src/noticeClose.web.js')
  for (const serviceWorker of [undefined, { getRegistration: async () => undefined }, { getRegistration: async () => { throw new Error('gone') } }, { getRegistration: async () => ({ active: { postMessage () { throw new Error('gone') } } }) }]) {
    navigatorStub(t, serviceWorker)
    t.is(await closeNotices(['varanda-dm']), undefined)
  }
})

test('seen-sync: only the exact worker signal wakes remote and cleanup removes the listener', async (t) => {
  let receive
  let removed
  navigatorStub(t, {
    addEventListener: (type, fn) => { receive = fn },
    removeEventListener: (type, fn) => { removed = fn }
  })
  const { subscribeSeenSync } = await import('../src/noticeClose.web.js')
  const wakes = []
  const off = subscribeSeenSync((reason) => wakes.push(reason))
  for (const data of [null, [], { type: 'other' }, { type: 'varanda-seen-sync', close: [] }]) receive({ data })
  t.alike(wakes, [])
  receive({ data: { type: 'varanda-seen-sync' } })
  t.alike(wakes, ['remote'])
  off()
  t.is(removed, receive)
})

function pushProbe (answer) {
  let check
  let ping
  let closed = false
  const sent = []
  const timers = new Set()
  const source = fs.readFileSync(path.join(__dirname, '../src/usePush.web.js'), 'utf8')
  const { code } = transformSync(source, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const modules = {
    react: {},
    './account': { pushCheck: async (args) => { sent.push(args) } },
    './pushClient': {},
    './push-offer': { createPushStore: ({ pushCheck }) => { check = pushCheck; return {} } },
    './dm-open': {},
    './vitrine/enabled': { vitrineEnabled: () => false }
  }
  runInNewContext(code, {
    exports: {},
    process: { env: {} },
    require: (name) => modules[name],
    setTimeout: (fn) => { timers.add(fn); return fn },
    clearTimeout: (fn) => timers.delete(fn),
    navigator: {
      serviceWorker: {
        addEventListener () {},
        getRegistration: async () => ({ active: { postMessage: (message, ports) => { ping = message; ports[0].answer(answer) } } })
      }
    },
    MessageChannel: class {
      constructor () {
        this.port1 = { close: () => { closed = true } }
        this.port2 = { answer: (data) => this.port1.onmessage({ data }) }
      }
    }
  })
  return { check, sent, timers, ping: () => ping, closed: () => closed }
}

test('push check: capabilities come from the active worker ping, never from the window version', async (t) => {
  for (const caps of [undefined, [], ['seen-sync'], ['unknown'], ['seen-sync', 'seen-sync']]) {
    const probe = pushProbe({ source: 'varanda-sw', push: 1, ...(caps === undefined ? {} : { caps }) })
    await probe.check({ endpoint: 'fixture' })
    t.is(probe.ping().type, 'varanda-push-ping')
    const reported = Array.isArray(caps) && caps.length <= 1 && (caps.length === 0 || caps[0] === 'seen-sync')
    t.is(Object.hasOwn(probe.sent[0], 'caps'), reported)
    if (reported) t.alike(probe.sent[0].caps, caps)
    t.ok(probe.closed())
    t.is(probe.timers.size, 0)
  }
})
