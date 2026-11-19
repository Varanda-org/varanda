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

test('closeNotices: native does nothing, including without browser globals', async (t) => {
  navigatorStub(t, new Proxy({}, { get () { throw new Error('native touched the browser') } }))
  const native = await import('../src/noticeClose.native.js')
  t.is(native.closeNotices(['varanda-dm']), undefined)
  const off = native.subscribeSeenSync(() => t.fail('native received a signal'))
  t.is(off(), undefined)
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
